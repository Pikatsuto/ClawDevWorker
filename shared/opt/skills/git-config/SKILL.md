---
name: git-config
description: "Configure the git identity (author name and email) used by the agent for commits. Can be set globally (all projects) or per-project. The agent NEVER commits under a brand name — the identity is controlled by the user."
metadata: {"openclaw":{"emoji":"🔧"}}
user-invocable: true
always: false
requires:
  bins: [node]
  env: [PROJECT_DATA_DIR]
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# git-config — Agent git identity

## Commands

| Command | Action |
|---------|--------|
| `/git-config set <name> <email>` | Set git identity globally (all projects) |
| `/git-config set <name> <email> --project` | Set git identity for the current project only |
| `/git-config show` | Show current git identity (global + project override if any) |
| `/git-config clear` | Remove global identity (fallback to AGENT_GIT_LOGIN) |
| `/git-config clear --project` | Remove project override (fallback to global) |

## Resolution order

When the agent commits, the git identity is resolved in this order:

1. **Project-level** (`$PROJECT_DATA_DIR/$PROJECT_NAME/.coderclaw/git-config.json`) — highest priority
2. **Global** (`$PROJECT_DATA_DIR/.coderclaw/git-config.json`)
3. **Fallback** — `AGENT_GIT_LOGIN` env var as name, `${AGENT_GIT_LOGIN}@localhost` as email

## /git-config set Procedure

### Global

```bash
CONFIG_DIR="${PROJECT_DATA_DIR}/.coderclaw"
CONFIG_FILE="${CONFIG_DIR}/git-config.json"
mkdir -p "$CONFIG_DIR"
```

Write:
```json
{
  "name": "<name>",
  "email": "<email>",
  "updatedAt": "<ISO date>"
}
```

### Per-project (with --project flag)

```bash
CONFIG_DIR="${PROJECT_DATA_DIR}/${PROJECT_NAME}/.coderclaw"
CONFIG_FILE="${CONFIG_DIR}/git-config.json"
mkdir -p "$CONFIG_DIR"
```

Same JSON format.

## /git-config show Procedure

1. Read project-level config if exists
2. Read global config if exists
3. Display:

```
Git identity:
  Global:  <name> <<email>>
  Project: <name> <<email>> (overrides global)
  Active:  <name> <<email>>
```

If no config exists:
```
Git identity:
  No custom identity configured.
  Using fallback: agent <agent@localhost>
  Set one with: /git-config set "Your Name" "email@example.com"
```

## How workers use this config

At startup, the worker entrypoint reads the config and applies it:

```bash
# Read git identity from project_data (project-level > global > fallback)
GIT_NAME="${AGENT_GIT_LOGIN:-agent}"
GIT_EMAIL="${AGENT_GIT_LOGIN:-agent}@localhost"

PROJECT_CONFIG="${PROJECT_DATA_DIR}/${PROJECT_NAME}/.coderclaw/git-config.json"
GLOBAL_CONFIG="${PROJECT_DATA_DIR}/.coderclaw/git-config.json"

if [ -f "$PROJECT_CONFIG" ]; then
  GIT_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PROJECT_CONFIG','utf8')).name)")
  GIT_EMAIL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PROJECT_CONFIG','utf8')).email)")
elif [ -f "$GLOBAL_CONFIG" ]; then
  GIT_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$GLOBAL_CONFIG','utf8')).name)")
  GIT_EMAIL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$GLOBAL_CONFIG','utf8')).email)")
fi

git config user.name "$GIT_NAME"
git config user.email "$GIT_EMAIL"
```

## Storage

- Global: `$PROJECT_DATA_DIR/.coderclaw/git-config.json`
- Per-project: `$PROJECT_DATA_DIR/$PROJECT_NAME/.coderclaw/git-config.json`
- Shared across all containers via the `project_data` volume
