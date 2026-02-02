###### English version [here](https://github.com/johan-perso/obsidian-gitpush/blob/main/README.md).

# Obsidian GitPush

Une extension pour Obsidian pour synchroniser les fichiers de votre coffre avec un dépôt GitHub, sans avoir à utiliser un client Git local.  
Vous pouvez configurer plusieurs dépôts pour différents dossiers, et spécifier la branche, le chemin dans le dépôt pour les documents, et le chemin pour les images.

*Vibe-codé en 4h, j'ai pas trop relu le code, si ça marche, c'est bien, sinon tant pis - j'voulais pas me prendre la tête, j'ai pas trop le temps et j'ai un projet plus important en cours.*

## Installation

1. Téléchargez le fichier ZIP de l'extension depuis la [page des releases](https://github.com/johan-perso/obsidian-gitpush/releases/latest).
2. Ouvrez Obsidian et allez dans les paramètres.
3. Cliquez sur « Modules complémentaires » dans le menu de gauche.
4. Ouvrez le dossier des extensions en cliquant sur l'icône de dossier à côté de « Extensions installées ».
5. Créez-y un dossier nommé `obsidian-gitpush` et placez le contenu du ZIP à l'intérieur.
6. Redémarrez Obsidian et retournez dans les réglages pour activer le plugin.

## Configuration

### 1. Authentification GitHub

1. Allez dans les **paramètres d'Obsidian** → **GitPush**
2. Générez un **Personal Access Token** sur GitHub :
   - Rendez-vous sur [github.com/settings/tokens](https://github.com/settings/tokens)
   - Cliquez sur « Generate new token » (Classic ou Fine-grained)
   - **Permissions requises** :
     - Token Classic : scope `repo` (accès complet aux dépôts)
     - Fine-grained Token : `Contents` (Read & Write)
3. Copiez le token généré et collez-le dans le champ prévu dans les paramètres

### 2. Configuration par dossier

Créez un fichier `.obsidian-gitpush.json` à la racine du dossier que vous souhaitez synchroniser. Ce fichier est au format JSON et doit contenir les informations suivantes :
- `repo`: dépôt GitHub au format `username/repository` (sans URL complète, ni suffixe `.git` à la fin)
- `branch`: branche par défaut où les fichiers seront poussés et tirés (ex: `main`, `master`, etc.)
- `path`: chemin dans le dépôt où les fichiers seront poussés (ex: `content`)
- `imagesPath`: chemin dans le dépôt où les images attachées aux documents seront poussées (ex: `images`)

Exemple :

```json
{
  "repo": "username/repository",
  "branch": "main",
  "path": "content",
  "imagesPath": "images"
}
```

## Utilisation

1. Ouvrez un document dans le dossier configuré.
2. Cliquez sur l'icône GitPush dans la barre latérale droite, ou utilisez « Open GitPush Panel » dans la palette de commandes (Cmd/Ctrl+P).
3. Utilisez les boutons « Push » et « Pull » pour pousser vos modifications locales vers le dépôt, ou recevoir les modifications depuis GitHub.

## Fonctionnalités supplémentaires

- Détection des fichiers `.gitignore` pour éviter de pousser des fichiers non désirés.
- Détection automatique des conflits et gestion des erreurs.
- Support des images attachées aux documents.
- Support des dépôts privés.

> En cas de problème, vous pouvez ouvrir une [issue](https://github.com/johan-perso/obsidian-gitpush/issues) pour le signaler.

## Limitations

- Taille des fichiers limitée à 100 MB
- Pas de système de fusion (merge) en cas de conflits complexes (vous devez choisir d'annuler les modifications locales ou distantes)
- L'extension ne supporte qu'une seule branche par configuration de dossier pour la synchronisation.
- Maximum de  5000 requêtes par heure avec l'API GitHub (ce qui reste largement suffisant).

## Licence

MIT © [Johan](https://johanstick.fr). [Soutenez ce projet](https://johanstick.fr/#donate) si vous souhaitez m'aider 💙  
