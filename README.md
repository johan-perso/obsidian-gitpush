###### Version française [ici](https://github.com/johan-perso/obsidian-gitpush/blob/main/README.fr.md).

# Obsidian GitPush

An Obsidian plugin to synchronize the files in your vault with a GitHub repository, without needing to use a local Git client.  
You can configure multiple repositories for different folders, and specify the branch, the path in the repository used for documents, and the path used for images.

*Vibe-coded in 4 hours, I didn't really check the code manually. If it works, that's good, otherwise, too bad - I didn't want to bother myself, I don't have much time and I have a more important project in progress.*


## Installation

1. Download the ZIP file of the plugin from the [latest release](https://github.com/johan-perso/obsidian-gitpush/releases/latest).
2. Open Obsidian and go to the settings.
3. Click on "Community plugins" in the left menu.
4. Open the plugins folder by clicking the folder icon next to "Installed plugins".
5. Create a folder named `obsidian-gitpush` and place the contents of the ZIP inside.
6. Restart Obsidian and return to the settings to enable the plugin.

## Configuration

### 1. GitHub Authentication

1. Go to **Obsidian settings** → **GitPush**
2. Generate a **Personal Access Token** on GitHub:
   - Visit [github.com/settings/tokens](https://github.com/settings/tokens)
   - Click on "Generate new token" (Classic or Fine-grained)
   - **Required permissions**:
     - Classic Token: `repo` scope (full repository access)
     - Fine-grained Token: `Contents` (Read & Write)
3. Copy the generated token and paste it in the designated field in the settings

### 2. Folder Configuration

Create a `.obsidian-gitpush.json` file at the root of the folder you want to synchronize. This JSON file must contain the following information:
- `repo`: GitHub repository in `username/repository` format (without the full URL, nor the `.git` suffix at the end)
- `branch`: default branch where files will be pushed and pulled (e.g., `main`, `master`, etc.)
- `path`: path in the repository where files will be pushed (e.g., `content`)
- `imagesPath`: path in the repository where images attached to documents will be pushed (e.g., `images`)

Example:

```json
{
  "repo": "username/repository",
  "branch": "main",
  "path": "content",
  "imagesPath": "images"
}
```

## Usage

1. Open a document from the configured folder.
2. Click on the GitPush icon in the right sidebar, or use "Open GitPush Panel" in the command palette (Cmd/Ctrl+P).
3. Use the "Push" and "Pull" buttons to push your local changes to the repository, or retrieve changes from GitHub.

## Additional Features

- Detection of `.gitignore` files to avoid pushing unwanted files.
- Support for images attached to Obsidian documents.
- Automatic conflict detection and error handling.
- Supports private repositories.

> If you encounter any issues, you can report them by opening an [issue](https://github.com/johan-perso/obsidian-gitpush/issues).

## Limitations

- File size limited to 100 MB
- No merge system for complex conflicts (you must choose to discard local or remote changes)
- The plugin only supports one branch per folder configuration for synchronization.
- Maximum of 5000 requests per hour with the GitHub API (which remains largely sufficient).

## License

MIT © [Johan](https://johanstick.fr/). [Support this project](https://johanstick.fr/#donate) if you want to help me 💙
