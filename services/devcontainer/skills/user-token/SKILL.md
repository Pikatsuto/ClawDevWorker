---
name: user-token
description: "Manages the developer's personal git token (separate from the agent token). The user token is required to create repos on their Forgejo/GitHub account. Stored in the user's persistent volume, never in global env vars. Commands: /token set, /token status, /token clear."
metadata: {"openclaw":{"emoji":"🔑"}}
user-invocable: true
always: false
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# user-token — Developer's personal git token

## Why two tokens?

```
GIT_PROVIDER_1_TOKEN (agent token) -> "agent" account on Forgejo
  -> comments on issues, creates PRs, pushes code on behalf of the agent

User token (personal token) -> DEVELOPER's account on Forgejo/GitHub
  -> creates repos, owns them, invites the agent as collaborator
  -> stored in ~/.openclaw/user-tokens/<userId>.json
  -> NEVER in a global environment variable
```

## Commands

| Command | Action |
|---------|--------|
| `/token set <token>` | Register the user's git token |
| `/token set forgejo <token>` | Forgejo-specific token |
| `/token set github <token>` | GitHub-specific token |
| `/token status` | Check registered tokens (masked) |
| `/token clear` | Delete the user's tokens |

## /token set Procedure

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

## Token validation

After `/token set`, validate that the token works by calling the API:

```javascript
// Forgejo: GET /api/v1/user
// GitHub:  GET https://api.github.com/user
// Check that the status is 200 and retrieve the user's login
```

Display: `✓ Forgejo token validated — logged in as @{login}`

## Token generation

If the user doesn't have a token:

**Forgejo:**
> Go to Forgejo -> Settings -> Applications -> Generate Token
> Required permissions: `repo` (Read + Write)
> Paste it here with `/token set forgejo <token>`

**GitHub:**
> Go to GitHub -> Settings -> Developer Settings -> Personal access tokens -> Fine-grained
> Permissions: Contents (Read + Write), Issues (Read + Write), Metadata (Read)
> Paste it with `/token set github <token>`
