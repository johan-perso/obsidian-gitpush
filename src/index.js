import {
	ItemView,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	TFile,
	TFolder,
	normalizePath,
	setIcon,
	setTooltip
} from "obsidian"
import { Octokit } from "@octokit/rest"
import ignore from "ignore"
import * as crypto from "crypto"

const VIEW_TYPE_GITPUSH = "gitpush-view"

const DEFAULT_SETTINGS = {
	githubToken: "",
	lastBranch: "main",
	lastSyncedState: {} // pathInRepo -> sha
}

function getGitBlobSha(contentBuffer) {
	const size = contentBuffer.byteLength
	const header = `blob ${size}\0`
	const headerBuffer = Buffer.from(header)
	const combined = Buffer.concat([headerBuffer, Buffer.from(contentBuffer)])
	return crypto.createHash("sha1").update(combined).digest("hex")
}

function getOctokit(token) {
	return new Octokit({
		auth: token,
		request: {
			fetch: (url, opts) => {
				const urlObj = new URL(url)
				urlObj.searchParams.append("_", Date.now())
				return fetch(urlObj.toString(), {
					...opts,
					cache: "no-store",
					headers: { ...opts.headers }
				})
			}
		}
	})
}

class GitPushView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf)
		this.plugin = plugin

		this.repoConfig = null
		this.repoConfigPath = null

		this.localFiles = []
		this.remoteTree = null
		this.remoteError = null

		this.filesToPush = []
		this.filesToPull = []
		this.conflicts = []

		this.isRefreshing = false
		this.pendingRefreshArgs = null
	}

	getViewType() {
		return VIEW_TYPE_GITPUSH
	}

	getDisplayText() {
		return "GitPush"
	}

	getIcon() {
		return "github"
	}

	async onOpen() {
		this.app.workspace.onLayoutReady(() => {
			this.refresh({ fetchRemote: true })
		})

		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			this.refresh({ fetchRemote: false, activeFile: file })
		}))

		this.registerEvent(this.app.vault.on("modify", () => this.debouncedRefresh()))
		this.registerEvent(this.app.vault.on("create", () => this.debouncedRefresh()))
		this.registerEvent(this.app.vault.on("delete", () => this.debouncedRefresh()))
		this.registerEvent(this.app.vault.on("rename", () => this.debouncedRefresh()))
	}

	debouncedRefresh() {
		if (this.debounceTimer) clearTimeout(this.debounceTimer)
		this.debounceTimer = setTimeout(() => this.refresh({ fetchRemote: false }), 1000)
	}

	async refresh(args = {}) {
		if (this.isRefreshing) {
			this.pendingRefreshArgs = args
			return
		}

		this.isRefreshing = true
		this.render()

		try {
			await this.doRefresh(args)
		} catch (e) {
			console.error("GitPush refresh error:", e)
		} finally {
			this.isRefreshing = false

			if (this.pendingRefreshArgs) {
				const nextArgs = this.pendingRefreshArgs
				this.pendingRefreshArgs = null
				this.refresh(nextArgs)
			} else {
				this.render()
			}
		}
	}

	async doRefresh({ fetchRemote = false, activeFile = undefined } = {}) {
		const configChanged = await this.updateRepoConfig(activeFile)

		if (this.repoConfig) {
			await this.scanLocalFiles()

			if (fetchRemote || configChanged || (!this.remoteTree && !this.remoteError)) {
				await this.fetchRemoteTree()
			}

			this.calculateDiff()
		} else {
			this.resetState()
		}
	}

	resetState() {
		this.repoConfig = null
		this.repoConfigPath = null
		this.localFiles = []
		this.filesToPush = []
		this.filesToPull = []
		this.conflicts = []
		this.remoteTree = null
		this.remoteError = null
	}

	async updateRepoConfig(file) {
		let activeFile
		if (file === undefined) {
			activeFile = this.app.workspace.getActiveFile()
		} else {
			activeFile = file
		}

		let newConfig = null
		let newConfigPath = null

		if (activeFile) {
			let currentFolder = activeFile.parent
			while (currentFolder) {
				const configPath = normalizePath(`${currentFolder.path}/.obsidian-gitpush.json`)
				if (await this.app.vault.adapter.exists(configPath)) {
					try {
						const content = await this.app.vault.adapter.read(configPath)
						newConfig = JSON.parse(content)
						newConfigPath = currentFolder.path
						break
					} catch (e) {
						console.error("Failed to parse .obsidian-gitpush.json", e)
					}
				}
				if (currentFolder.isRoot()) break
				currentFolder = currentFolder.parent
			}
		}

		const changed = newConfigPath !== this.repoConfigPath

		if (changed) {
			this.repoConfig = newConfig
			this.repoConfigPath = newConfigPath

			// Always clear remote state on config change
			this.remoteTree = null
			this.remoteError = null
			this.localFiles = []
			this.filesToPush = []
			this.filesToPull = []
			this.conflicts = []
		}

		return changed
	}

	async scanLocalFiles() {
		if (!this.repoConfig || this.repoConfigPath === null) return

		const files = []
		const folder = this.app.vault.getAbstractFileByPath(this.repoConfigPath)

		if (folder instanceof TFolder) {
			const gitignore = await this.getGitignore(folder)

			const scan = async (f) => {
				if (f instanceof TFile) {
					const relativePath = f.path.substring(this.repoConfigPath.length).replace(/^\//, "")
					if (f.name === ".obsidian-gitpush.json") return
					if (gitignore && gitignore.ignores(relativePath)) return

					try {
						const content = await this.app.vault.readBinary(f)
						const sha = getGitBlobSha(content)
						const pathInRepo = normalizePath(`${this.repoConfig.path || ""}/${relativePath}`).replace(/^\//, "")

						files.push({
							file: f,
							sha: sha,
							pathInRepo: pathInRepo,
							localPath: relativePath
						})
					} catch (e) {
						console.error(`Error reading ${f.path}`, e)
					}

				} else if (f instanceof TFolder) {
					for (const child of f.children) {
						await scan(child)
					}
				}
			}

			for (const child of folder.children) {
				await scan(child)
			}
		}
		this.localFiles = files
	}

	async getGitignore(folder) {
		const path = normalizePath(`${folder.path}/.gitignore`)
		if (await this.app.vault.adapter.exists(path)) {
			try {
				const content = await this.app.vault.adapter.read(path)
				return ignore().add(content)
			} catch (e) {
				return null
			}
		}
		return null
	}

	async fetchRemoteTree() {
		if (!this.plugin.settings.githubToken || !this.repoConfig) return

		this.remoteTree = null
		this.remoteError = null

		const [owner, repo] = this.repoConfig.repo.split("/")
		const branch = this.branchInput ? this.branchInput.value : (this.plugin.settings.lastBranch || "main")

		const octokit = getOctokit(this.plugin.settings.githubToken)

		try {
			const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` })
			const latestCommitSha = refData.object.sha

			const { data: treeData } = await octokit.git.getTree({
				owner,
				repo,
				tree_sha: latestCommitSha,
				recursive: true
			})

			const newTree = new Map()
			for (const item of treeData.tree) {
				if (item.type === "blob") {
					newTree.set(item.path, item.sha)
				}
			}
			this.remoteTree = newTree
		} catch (e) {
			console.error("Failed to fetch remote tree", e)
			this.remoteTree = null
			this.remoteError = e.message || "Unknown error"
		}
	}

	calculateDiff() {
		this.filesToPush = []
		this.filesToPull = []
		this.conflicts = []

		if (!this.remoteTree) return

		const lastSynced = this.plugin.settings.lastSyncedState || {}
		const remoteTree = this.remoteTree
		const prefix = (this.repoConfig.path || "").replace(/^\//, "").replace(/\/$/, "")

		const localMap = new Map()
		this.localFiles.forEach(f => localMap.set(f.pathInRepo, f))

		const allPaths = new Set([...localMap.keys()])
		for (const path of remoteTree.keys()) {
			if (!prefix || path.startsWith(prefix)) {
				allPaths.add(path)
			}
		}

		let stateUpdated = false

		for (const path of allPaths) {
			const local = localMap.get(path)
			const localSha = local ? local.sha : null
			const remoteSha = remoteTree.get(path)
			const lastSha = lastSynced[path]

			if (localSha === remoteSha) {
				if (lastSha !== localSha && localSha) {
					lastSynced[path] = localSha
					stateUpdated = true
				}
				continue
			}

			if (localSha && !remoteSha) {
				if (!lastSha) {
					this.filesToPush.push({ ...local, status: "new" })
				} else {
					this.filesToPull.push({ pathInRepo: path, sha: null, status: "deleted-remotely", localFile: local.file })
				}
				continue
			}

			if (!localSha && remoteSha) {
				if (lastSha === remoteSha) {
					this.filesToPush.push({ pathInRepo: path, sha: null, status: "deleted", remoteSha: remoteSha, localPath: path.substring(prefix.length).replace(/^\//, "") })
				} else if (lastSha && lastSha !== remoteSha) {
					this.conflicts.push({
						pathInRepo: path,
						localSha: null,
						remoteSha: remoteSha,
						localFile: null,
						localPath: path.substring(prefix.length).replace(/^\//, "")
					})
				} else {
					this.filesToPull.push({ pathInRepo: path, sha: remoteSha, status: "new-remote" })
				}
				continue
			}

			if (localSha && remoteSha) {
				if (localSha === lastSha && remoteSha !== lastSha) {
					this.filesToPull.push({
						pathInRepo: path,
						sha: remoteSha,
						status: "modified-remote",
						localFile: local.file
					})
				} else if (localSha !== lastSha && remoteSha === lastSha) {
					this.filesToPush.push({ ...local, status: "modified" })
				} else {
					this.conflicts.push({
						pathInRepo: path,
						localSha: localSha,
						remoteSha: remoteSha,
						localFile: local.file,
						localPath: local.localPath
					})
				}
			}
		}

		if (stateUpdated) {
			this.plugin.settings.lastSyncedState = lastSynced
			this.plugin.saveSettings()
		}
	}

	resolveConflict(conflict, strategy) {
		this.conflicts = this.conflicts.filter(c => c.pathInRepo !== conflict.pathInRepo)

		if (strategy === "local") {
			if (conflict.localSha) {
				const local = this.localFiles.find(f => f.pathInRepo === conflict.pathInRepo)
				if (local) this.filesToPush.push({ ...local, status: "modified (force)" })
			} else {
				this.filesToPush.push({
					pathInRepo: conflict.pathInRepo,
					sha: null,
					status: "deleted (force)",
					remoteSha: conflict.remoteSha,
					localPath: conflict.localPath
				})
			}
		} else if (strategy === "remote") {
			if (conflict.remoteSha) {
				this.filesToPull.push({
					pathInRepo: conflict.pathInRepo,
					sha: conflict.remoteSha,
					status: "modified-remote (force)",
					localFile: conflict.localFile
				})
			} else {
				this.filesToPull.push({
					pathInRepo: conflict.pathInRepo,
					sha: null,
					status: "deleted-remotely (force)",
					localFile: conflict.localFile
				})
			}
		}
		this.render()
	}

	async onPush() {
		if (this.filesToPush.length === 0) return

		const token = this.plugin.settings.githubToken
		if (!token) return

		const commitMessage = this.commitInput.value || "Update from Obsidian"
		const branch = this.branchInput.value || "main"

		const octokit = getOctokit(token)
		const [owner, repo] = this.repoConfig.repo.split("/")
		const lastSynced = this.plugin.settings.lastSyncedState || {}

		new Notice(`Pushing ${this.filesToPush.length} changes...`)

		try {
			for (const item of this.filesToPush) {
				if (item.status.startsWith("deleted")) {
					await octokit.repos.deleteFile({
						owner,
						repo,
						path: item.pathInRepo,
						message: `Delete ${item.pathInRepo}`,
						sha: item.remoteSha,
						branch
					})
					delete lastSynced[item.pathInRepo]
					if (this.remoteTree) this.remoteTree.delete(item.pathInRepo)
					continue
				}

				const content = await this.app.vault.readBinary(item.file)
				const currentRemoteSha = this.remoteTree ? this.remoteTree.get(item.pathInRepo) : undefined

				await octokit.repos.createOrUpdateFileContents({
					owner,
					repo,
					path: item.pathInRepo,
					message: commitMessage,
					content: Buffer.from(content).toString("base64"),
					branch,
					sha: currentRemoteSha
				})

				if (this.remoteTree) this.remoteTree.set(item.pathInRepo, item.sha)
				lastSynced[item.pathInRepo] = item.sha

				if (item.file.extension === "md") {
					await this.pushImagesInMarkdown(item.file, octokit, owner, repo, branch, lastSynced)
				}
			}
			new Notice("Push successful!")
			this.plugin.settings.lastBranch = branch
			this.plugin.settings.lastSyncedState = lastSynced
			await this.plugin.saveSettings()
			await this.refresh({ fetchRemote: true })
		} catch (e) {
			console.error(e)
			new Notice(`Push failed: ${e.message}`)
		}
	}

	async pushImagesInMarkdown(file, octokit, owner, repo, branch, lastSynced) {
		const text = await this.app.vault.read(file)
		const imageRegex = /!\[\[(.*?)\]\]|!\[.*?\]\((.*?)\)/g
		let match
		while ((match = imageRegex.exec(text)) !== null) {
			const imageName = (match[1] || match[2]).split("|")[0].split("#")[0]
			const imageFile = this.app.metadataCache.getFirstLinkpathDest(imageName, file.path)
			if (imageFile && ["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(imageFile.extension.toLowerCase())) {
				const imgContent = await this.app.vault.readBinary(imageFile)
				const imgPathInRepo = normalizePath(`${this.repoConfig.imagesPath || "images"}/${imageFile.name}`).replace(/^\//, "")

				let imgSha
				if (this.remoteTree) imgSha = this.remoteTree.get(imgPathInRepo)
				const localImgSha = getGitBlobSha(imgContent)

				if (imgSha !== localImgSha) {
					await octokit.repos.createOrUpdateFileContents({
						owner,
						repo,
						path: imgPathInRepo,
						message: `Upload image ${imageFile.name}`,
						content: Buffer.from(imgContent).toString("base64"),
						branch,
						sha: imgSha
					})
					if (this.remoteTree) this.remoteTree.set(imgPathInRepo, localImgSha)
					lastSynced[imgPathInRepo] = localImgSha
				}
			}
		}
	}

	async onPull() {
		if (this.filesToPull.length === 0) return

		const token = this.plugin.settings.githubToken
		const branch = this.branchInput.value || "main"
		const octokit = getOctokit(token)
		const [owner, repo] = this.repoConfig.repo.split("/")
		const lastSynced = this.plugin.settings.lastSyncedState || {}

		new Notice(`Pulling ${this.filesToPull.length} changes...`)

		try {
			for (const item of this.filesToPull) {
				if (item.status.startsWith("deleted-remotely")) {
					if (item.localFile) {
						await this.app.vault.delete(item.localFile)
					}
					delete lastSynced[item.pathInRepo]
					if (this.remoteTree) this.remoteTree.delete(item.pathInRepo)
					continue
				}

				const { data: fileData } = await octokit.repos.getContent({
					owner,
					repo,
					path: item.pathInRepo,
					ref: branch
				})

				if (Array.isArray(fileData)) continue

				const content = Buffer.from(fileData.content, "base64")
				const prefix = (this.repoConfig.path || "").replace(/^\//, "").replace(/\/$/, "")
				let relativePath = item.pathInRepo
				if (prefix && relativePath.startsWith(prefix)) {
					relativePath = relativePath.substring(prefix.length).replace(/^\//, "")
				}

				const localPath = normalizePath(`${this.repoConfigPath}/${relativePath}`)
				const folderPath = localPath.substring(0, localPath.lastIndexOf("/"))

				if (folderPath && !await this.app.vault.adapter.exists(folderPath)) {
					await this.app.vault.createFolder(folderPath)
				}

				if (await this.app.vault.adapter.exists(localPath)) {
					const existingFile = this.app.vault.getAbstractFileByPath(localPath)
					if (existingFile instanceof TFile) {
						await this.app.vault.modifyBinary(existingFile, content)
					}
				} else {
					await this.app.vault.createBinary(localPath, content)
				}

				lastSynced[item.pathInRepo] = item.sha
			}
			new Notice("Pull successful!")
			this.plugin.settings.lastSyncedState = lastSynced
			await this.plugin.saveSettings()
			await this.refresh({ fetchRemote: true })
		} catch (e) {
			console.error(e)
			new Notice(`Pull failed: ${e.message}`)
		}
	}

	render() {
		const { contentEl } = this
		contentEl.empty()
		contentEl.addClass("gitpush-side-panel")

		// Header removed as requested

		if (!this.repoConfig) {
			contentEl.createEl("div", {
				text: "No repository configuration found. Please create a '.obsidian-gitpush.json' file in your project folder.",
				attr: { style: "padding: 15px; color: var(--text-muted); font-size: 0.9em;" }
			})
			return
		}

		// Repository Info Section with integrated refresh
		const repoSection = contentEl.createDiv({ cls: "gitpush-repo-info", attr: { style: "padding: 10px; margin: 10px; border: 1px solid var(--background-modifier-border); position: relative;" } })

		const repoHeader = repoSection.createEl("h4", { attr: { style: "margin: 0 0 5px 0; font-size: 0.8em; text-transform: uppercase;" } })
		repoHeader.createSpan({ text: "Repository " })
		repoHeader.createSpan({ text: "• GitPush", attr: { style: "opacity: 0.5;" } })

		const refreshBtn = repoSection.createEl("button", {
			cls: "clickable-icon",
			attr: { style: "position: absolute; top: 5px; right: 5px; height: 24px; width: 24px; padding: 0;" }
		})
		setIcon(refreshBtn, "refresh-cw")
		refreshBtn.addEventListener("click", () => this.refresh({ fetchRemote: true }))

		repoSection.createDiv({ text: this.repoConfig.repo, attr: { style: "font-weight: bold; overflow: hidden; text-overflow: ellipsis;" } })
		repoSection.createDiv({ text: `Source: ${this.repoConfigPath}`, attr: { style: "font-size: 0.8em; color: var(--text-muted); margin-top: 2px;" } })
		repoSection.createDiv({ text: `Target: ${this.repoConfig.path || "/"}`, attr: { style: "font-size: 0.8em; color: var(--text-muted); margin-top: 2px;" } })

		const statusDiv = repoSection.createDiv({ attr: { style: "font-size: 0.8em; margin-top: 5px;" } })
		if (this.isRefreshing) {
			statusDiv.setText("Checking for changes...")
			statusDiv.style.color = "var(--text-accent)"
		} else if (this.remoteError) {
			statusDiv.setText(`Error: ${this.remoteError}`)
			statusDiv.style.color = "var(--text-error)"
		} else if (this.remoteTree) {
			statusDiv.setText("Synced with GitHub")
			statusDiv.style.color = "var(--text-success)"
		} else {
			statusDiv.setText("Not synced (Offline?)")
			statusDiv.style.color = "var(--text-muted)"
		}

		if (this.conflicts.length > 0) {
			const conflictSection = contentEl.createDiv({
				attr: { style: "padding: 10px; margin: 0 10px 10px 10px; border: 1px solid var(--text-error); border-radius: 4px; background-color: rgba(var(--color-red-rgb), 0.1);" }
			})
			conflictSection.createEl("h4", { text: `Conflicts (${this.conflicts.length})`, attr: { style: "margin: 0 0 10px 0; color: var(--text-error); font-size: 0.9em; text-transform: uppercase;" } })

			this.conflicts.forEach(c => {
				const container = conflictSection.createDiv({ attr: { style: "margin-bottom: 10px; padding: 10px; border: 1px solid var(--background-modifier-border); border-radius: 4px; background: var(--background-primary);" } })
				container.createDiv({ text: c.localPath, attr: { style: "font-weight: bold; margin-bottom: 8px; word-break: break-all;" } })

				const btnRow = container.createDiv({ attr: { style: "display: flex; gap: 8px;" } })
				const keepLocalBtn = btnRow.createEl("button", { text: "Keep Local", attr: { style: "flex: 1; font-size: 0.8em;" } })
				keepLocalBtn.addEventListener("click", () => this.resolveConflict(c, "local"))

				const keepRemoteBtn = btnRow.createEl("button", { text: "Keep Remote", attr: { style: "flex: 1; font-size: 0.8em;" } })
				keepRemoteBtn.addEventListener("click", () => this.resolveConflict(c, "remote"))
			})
		}

		const formSection = contentEl.createDiv({ attr: { style: "padding: 0 10px 10px 10px;" } })

		formSection.createEl("label", { text: "Commit Message" })
		this.commitInput = formSection.createEl("input", { type: "text", attr: { style: "width: 100%; margin-bottom: 10px;", placeholder: "Update files" } })

		formSection.createEl("label", { text: "Branch" })
		this.branchInput = formSection.createEl("input", { type: "text", attr: { style: "width: 100%; margin-bottom: 15px;" } })
		this.branchInput.value = this.plugin.settings.lastBranch || "main"

		const btnContainer = formSection.createDiv({ attr: { style: "display: flex; gap: 10px;" } })

		const pushLabel = this.filesToPush.length > 0 ? `Push (${this.filesToPush.length})` : "Push"
		const pushBtn = btnContainer.createEl("button", { text: pushLabel, cls: "mod-cta", attr: { style: "flex: 1;" } })

		if (this.filesToPush.length === 0) {
			pushBtn.disabled = true
		} else if (this.filesToPull.length > 0) {
			setTooltip(pushBtn, "Warning: You have remote changes. Please Pull before Pushing to avoid conflicts.", { placement: "top" })
			pushBtn.addClass("gitpush-warning")
		}
		if (this.conflicts.length > 0) {
			pushBtn.disabled = true
			setTooltip(pushBtn, "Please resolve conflicts before pushing.", { placement: "top" })
		}
		if (this.remoteError) {
			pushBtn.disabled = true
		}

		pushBtn.addEventListener("click", () => this.onPush())

		const pullLabel = this.filesToPull.length > 0 ? `Pull (${this.filesToPull.length})` : "Pull"
		const pullBtn = btnContainer.createEl("button", { text: pullLabel, attr: { style: "flex: 1;" } })

		if (this.filesToPull.length === 0) {
			pullBtn.disabled = true
		}
		if (this.conflicts.length > 0) {
			pullBtn.disabled = true
			setTooltip(pullBtn, "Please resolve conflicts before pulling.", { placement: "top" })
		}
		if (this.remoteError) {
			pullBtn.disabled = true
		}

		pullBtn.addEventListener("click", () => this.onPull())

		const listsSection = contentEl.createDiv({ attr: { style: "padding: 10px; flex: 1; display: flex; flex-direction: column; overflow: hidden; gap: 10px;" } })

		if (this.filesToPush.length > 0) {
			listsSection.createEl("h4", { text: "Local Changes (Push)", attr: { style: "margin: 0; font-size: 0.8em; text-transform: uppercase;" } })
			const pushList = listsSection.createDiv({ attr: { style: "max-height: 150px; overflow-y: auto; font-size: 0.85em; border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 5px;" } })
			this.filesToPush.forEach(f => {
				const div = pushList.createDiv({ attr: { style: "display: flex; justify-content: space-between;" } })
				div.createSpan({ text: f.localPath || f.localPath })
				div.createSpan({ text: f.status, attr: { style: "color: var(--text-muted); font-size: 0.9em;" } })
			})
		}

		if (this.filesToPull.length > 0) {
			listsSection.createEl("h4", { text: "Remote Changes (Pull)", attr: { style: "margin: 0; font-size: 0.8em; text-transform: uppercase;" } })
			const pullList = listsSection.createDiv({ attr: { style: "max-height: 150px; overflow-y: auto; font-size: 0.85em; border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 5px;" } })
			this.filesToPull.forEach(f => {
				const prefix = (this.repoConfig.path || "").replace(/^\//, "").replace(/\/$/, "")
				const relativePath = f.pathInRepo.startsWith(prefix) ? f.pathInRepo.substring(prefix.length).replace(/^\//, "") : f.pathInRepo
				const div = pullList.createDiv({ attr: { style: "display: flex; justify-content: space-between;" } })
				div.createSpan({ text: relativePath })
				div.createSpan({ text: f.status, attr: { style: "color: var(--text-muted); font-size: 0.9em;" } })
			})
		}

		if (this.filesToPush.length === 0 && this.filesToPull.length === 0 && this.conflicts.length === 0) {
			listsSection.createDiv({ text: "No changes detected.", attr: { style: "color: var(--text-muted); text-align: center; margin-top: 20px;" } })
		}
	}
}

export default class GitPushPlugin extends Plugin {
	async onload() {
		await this.loadSettings()

		this.registerView(
			VIEW_TYPE_GITPUSH,
			(leaf) => new GitPushView(leaf, this)
		)

		this.addCommand({
			id: "open-gitpush-panel",
			name: "Open GitPush Panel",
			callback: () => this.activateView(),
		})

		this.addSettingTab(new GitPushSettingTab(this.app, this))
	}

	async activateView() {
		const { workspace } = this.app
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_GITPUSH)[0]

		if (!leaf) {
			leaf = workspace.getRightLeaf(false)
			await leaf.setViewState({ type: VIEW_TYPE_GITPUSH, active: true })
		}

		workspace.revealLeaf(leaf)
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}
}

class GitPushSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin)
		this.plugin = plugin
	}

	display() {
		const { containerEl } = this
		containerEl.empty()

		containerEl.createEl("h2", { text: "GitPush Settings" })

		// --- Token Section ---
		containerEl.createEl("h3", { text: "GitHub Authentication" })

		const tokenSetting = new Setting(containerEl)
			.setName("GitHub Personal Access Token")
			.setDesc("You need a GitHub Personal Access Token to authenticate.")
			.addText(text => {
				text.setPlaceholder("ghp_xxxx")
					.setValue(this.plugin.settings.githubToken)
					.onChange(async (value) => {
						this.plugin.settings.githubToken = value
						await this.plugin.saveSettings()
					})
				text.inputEl.type = "password"
			})

		// Add details to description using DOM methods safely
		const descEl = tokenSetting.descEl
		descEl.createEl("br")
		descEl.createSpan({ text: "1. Go to " })
		descEl.createEl("a", {
			text: "GitHub Settings > Personal Access Tokens",
			href: "https://github.com/settings/tokens",
			attr: { target: "_blank" }
		})
		descEl.createEl("br")
		descEl.createSpan({ text: "2. Generate a new token (Classic or Fine-grained)." })
		descEl.createEl("br")
		descEl.createSpan({ text: "3. Ensure it has 'repo' scope (Classic) or 'Contents: Read & Write' (Fine-grained)." })

		// --- Configuration Section ---
		containerEl.createEl("h3", { text: "Repository Configuration" })

		const repoSetting = new Setting(containerEl)
			.setDesc("To link a folder in your vault to a GitHub repository, create a file named '.obsidian-gitpush.json' inside that folder.")

		repoSetting.descEl.style.display = "block"

		const codeContainer = repoSetting.descEl.createDiv({
			attr: { style: "position: relative; background: var(--background-secondary); padding: 15px; border-radius: 4px; border: 1px solid var(--background-modifier-border); margin-top: 10px;" }
		})

		const codeBlock = codeContainer.createEl("pre", {
			text: `{
  "repo": "username/repo",
  "branch": "main",
  "path": "vault-folder",
  "imagesPath": "vault-folder/images"
}`,
			attr: { style: "margin: 0; font-family: var(--font-monospace);" }
		})

		const copyBtn = codeContainer.createEl("button", {
			text: "Copy",
			attr: {
				style: "position: absolute; top: 10px; right: 10px; padding: 4px 8px; font-size: 0.8em;"
			}
		})

		copyBtn.addEventListener("click", () => {
			navigator.clipboard.writeText(codeBlock.textContent).then(() => {
				const originalText = copyBtn.innerText
				copyBtn.innerText = "Copied!"
				setTimeout(() => copyBtn.innerText = originalText, 2000)
			})
		})
	}
}