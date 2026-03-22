---
name: git-provider
description: "Accès Forgejo et GitHub depuis le chat. Utilise le token du USER (pas le token agent) pour les opérations sur son compte : créer des repos, inviter des collaborateurs, lire les issues et PRs. Requis par /spec init et /project status. Charge le token depuis ~/.openclaw/user-tokens/<userId>.json via le skill user-token."
metadata: {"openclaw":{"emoji":"🐙"}}
user-invocable: false
always: false
---

# git-provider — Opérations git depuis le chat

## Token utilisé

Ce skill utilise le token PERSONNEL du développeur (pas le token agent).
Il doit être enregistré avec `/token set` au préalable.

## Opérations disponibles

### Création de repo

```javascript
const { execSync } = require('child_process');
const path = require('path');

// Charger le token user
const TOKEN_FILE = path.join(process.env.HOME, '.openclaw', 'user-tokens',
  `${process.env.USER_ID || 'default'}.json`);
const tokens = JSON.parse(require('fs').readFileSync(TOKEN_FILE, 'utf8'));
const userToken = tokens.forgejo || tokens.github;
const providerUrl = process.env.GIT_PROVIDER_1_URL || 'http://host-gateway:3000';

// Créer repo via API Forgejo
async function createRepo({ name, description = '', private: isPrivate = true }) {
  const payload = JSON.stringify({ name, description, private: isPrivate, auto_init: true });
  // POST /api/v1/user/repos
}

// Inviter l'agent comme collaborateur
async function addCollaborator({ owner, repo, username, permission = 'write' }) {
  // PUT /api/v1/repos/{owner}/{repo}/collaborators/{username}
}

// Créer une issue
async function createIssue({ owner, repo, title, body, assignees = [] }) {
  // POST /api/v1/repos/{owner}/{repo}/issues
}

// Récupérer les issues ouvertes
async function listIssues({ owner, repo, state = 'open' }) {
  // GET /api/v1/repos/{owner}/{repo}/issues
}

// Récupérer les PRs
async function listPullRequests({ owner, repo, state = 'open' }) {
  // GET /api/v1/repos/{owner}/{repo}/pulls
}
```

### Commandes utilisateur

| Commande | Action |
|----------|--------|
| `/project status <owner/repo>` | Issues ouvertes, PRs, pipeline |
| `/project issues <owner/repo>` | Liste les issues avec leur statut |
| `/project prs <owner/repo>` | Liste les PRs |

## Utilisation dans /spec init

```
1. Vérifier token user disponible (via user-token skill)
2. createRepo({ name, private: true })
3. addCollaborator({ username: AGENT_GIT_LOGIN })
4. [BMAD génère les stories]
5. Pour chaque story : createIssue({ assignees: [AGENT_GIT_LOGIN] })
6. POST /deps sur l'orchestrateur pour le DAG
```

## Module partagé

Ce skill wrape `/opt/git-provider/index.js` qui contient l'implémentation
complète pour Forgejo et GitHub (déjà dans l'image via COPY).

```javascript
// Charger le provider avec le token user
const { loadProviders } = require('/opt/git-provider/index.js');
// Overrider le token avec celui du user pour cette opération
```
