---
name: user-token
description: "Gère le token git personnel du développeur (distinct du token agent). Le token user est requis pour créer des repos sur son compte Forgejo/GitHub. Stocké dans le volume persistant du user, jamais dans les env vars globales. Commandes : /token set, /token status, /token clear."
metadata: {"openclaw":{"emoji":"🔑"}}
user-invocable: true
always: false
---

# user-token — Token git personnel du développeur

## Pourquoi deux tokens ?

```
GIT_PROVIDER_1_TOKEN (token agent) → compte "agent" sur Forgejo
  → commente les issues, crée les PRs, pousse le code au nom de l'agent

Token user (token personnel) → compte du DÉVELOPPEUR sur Forgejo/GitHub
  → crée les repos, les possède, invite l'agent en collaborateur
  → stocké dans ~/.openclaw/user-tokens/<userId>.json
  → JAMAIS en variable d'env globale
```

## Commandes

| Commande | Action |
|----------|--------|
| `/token set <token>` | Enregistre le token git du user |
| `/token set forgejo <token>` | Token Forgejo spécifique |
| `/token set github <token>` | Token GitHub spécifique |
| `/token status` | Vérifie les tokens enregistrés (masqués) |
| `/token clear` | Supprime les tokens du user |

## Procédure /token set

```javascript
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');

const TOKEN_DIR  = path.join(process.env.HOME, '.openclaw', 'user-tokens');
const USER_ID    = process.env.USER_ID || 'default';
const TOKEN_FILE = path.join(TOKEN_DIR, `${USER_ID}.json`);

function saveToken(provider, token) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  let tokens = {};
  try { tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}
  tokens[provider] = token;
  tokens.updatedAt = new Date().toISOString();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }
  catch { return {}; }
}

function maskToken(t) {
  if (!t || t.length < 8) return '***';
  return t.slice(0, 4) + '****' + t.slice(-4);
}
```

## Validation du token

Après `/token set`, valider que le token fonctionne en appelant l'API :

```javascript
// Forgejo : GET /api/v1/user
// GitHub  : GET https://api.github.com/user
// Vérifier que le status est 200 et récupérer le login du user
```

Afficher : `✓ Token Forgejo validé — connecté en tant que @{login}`

## Génération du token

Si le user n'a pas de token :

**Forgejo :**
> Va dans Forgejo → Settings → Applications → Generate Token
> Permissions requises : `repo` (Read + Write)
> Paste-le ici avec `/token set forgejo <token>`

**GitHub :**
> Va dans GitHub → Settings → Developer Settings → Personal access tokens → Fine-grained
> Permissions : Contents (Read + Write), Issues (Read + Write), Metadata (Read)
> Paste-le avec `/token set github <token>`
