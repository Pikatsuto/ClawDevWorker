---
name: git-config
description: "Configure the git identity (author name and email) used for commits. Separate identities for agent (autonomous worker/chat) and user (devcontainer). Can be set globally or per-project."
metadata: {"openclaw":{"emoji":"🔧"}}
user-invocable: true
always: false
requires:
  bins: [node]
  env: [PROJECT_DATA_DIR]
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# git-config — Git identity management

Two separate identities:
- **agent** — used by autonomous workers and chat when committing on behalf of the pipeline
- **user** — used in devcontainer sessions when the human is coding interactively

## Commands

| Command | Action |
|---------|--------|
| `/git-config set agent <name> <email>` | Set agent identity globally |
| `/git-config set user <name> <email>` | Set user identity globally |
| `/git-config set agent <name> <email> --project` | Set agent identity for the current project |
| `/git-config set user <name> <email> --project` | Set user identity for the current project |
| `/git-config show` | Show all identities (agent + user, global + project) |
| `/git-config clear agent` | Remove agent global identity |
| `/git-config clear user` | Remove user global identity |
| `/git-config clear agent --project` | Remove agent project override |
| `/git-config clear user --project` | Remove user project override |

## Resolution order

Each surface resolves its own identity independently:

**Worker / Chat (surface = agent):**
1. Project-level agent config
2. Global agent config
3. Fallback: `AGENT_GIT_LOGIN` / `${AGENT_GIT_LOGIN}@localhost`

**Devcontainer (surface = user):**
1. Project-level user config
2. Global user config
3. Fallback: `USER_ID` / `${USER_ID}@localhost`

## Storage format

```json
{
  "agent": {
    "name": "cdw-agent",
    "email": "agent@git.example.com",
    "updatedAt": "2026-04-06T..."
  },
  "user": {
    "name": "Gabriel Guillou",
    "email": "gabriel@example.com",
    "updatedAt": "2026-04-06T..."
  }
}
```

## Storage locations

| Scope | Path |
|-------|------|
| Global | `$PROJECT_DATA_DIR/.coderclaw/git-config.json` |
| Per-project | `$PROJECT_DATA_DIR/$PROJECT_NAME/.coderclaw/git-config.json` |

Both are on the `project_data` volume — shared across all containers.

## /git-config set Procedure

1. Parse the surface (`agent` or `user`), name, and email from the command
2. Determine the config path (global or `--project`)
3. Read existing config (or create empty `{}`)
4. Update the surface key:

```bash
CONFIG_DIR="${PROJECT_DATA_DIR}/.coderclaw"  # or $PROJECT_DATA_DIR/$PROJECT_NAME/.coderclaw for --project
CONFIG_FILE="${CONFIG_DIR}/git-config.json"
mkdir -p "$CONFIG_DIR"
```

```javascript
const config = JSON.parse(fs.readFileSync(configFile, 'utf8') || '{}');
config[surface] = { name, email, updatedAt: new Date().toISOString() };
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
```

5. Confirm: "Git identity for **[surface]** set to **[name]** <**[email]**>"

## /git-config show Procedure

Display all configured identities:

```
Git identities:

  Agent (workers + chat):
    Global:  cdw-agent <agent@git.example.com>
    Project: (none — using global)
    Active:  cdw-agent <agent@git.example.com>

  User (devcontainer):
    Global:  Gabriel Guillou <gabriel@example.com>
    Project: (none — using global)
    Active:  Gabriel Guillou <gabriel@example.com>
```

## How each container reads the config

### Worker entrypoint (surface = agent)

```bash
GIT_ID_NAME="${AGENT_GIT_LOGIN:-agent}"
GIT_ID_EMAIL="${AGENT_GIT_LOGIN:-agent}@localhost"
PROJECT_CFG="${PROJECT_DATA_DIR}/${PROJECT_NAME}/.coderclaw/git-config.json"
GLOBAL_CFG="${PROJECT_DATA_DIR}/.coderclaw/git-config.json"

if [ -f "$PROJECT_CFG" ]; then
  GIT_ID_NAME=$(node -e "const c=JSON.parse(require('fs').readFileSync('$PROJECT_CFG','utf8'));console.log(c.agent?.name||'$GIT_ID_NAME')")
  GIT_ID_EMAIL=$(node -e "const c=JSON.parse(require('fs').readFileSync('$PROJECT_CFG','utf8'));console.log(c.agent?.email||'$GIT_ID_EMAIL')")
elif [ -f "$GLOBAL_CFG" ]; then
  GIT_ID_NAME=$(node -e "const c=JSON.parse(require('fs').readFileSync('$GLOBAL_CFG','utf8'));console.log(c.agent?.name||'$GIT_ID_NAME')")
  GIT_ID_EMAIL=$(node -e "const c=JSON.parse(require('fs').readFileSync('$GLOBAL_CFG','utf8'));console.log(c.agent?.email||'$GIT_ID_EMAIL')")
fi

git config user.name "$GIT_ID_NAME"
git config user.email "$GIT_ID_EMAIL"
```

### Devcontainer entrypoint (surface = user)

Same logic but reads `c.user?.name` and `c.user?.email` instead of `c.agent`.
Fallback: `USER_ID` / `${USER_ID}@localhost`.
