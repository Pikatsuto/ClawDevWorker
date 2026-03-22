---
name: devcontainer
description: "Manages ephemeral Code Server development sessions. Use /dev create to start a VSCode session in the browser, /dev release to close it, /dev status to see the state. The container is ephemeral (--rm) but the VSCode profile, extensions, and OpenClaw config persist in per-user volumes between sessions."
metadata: {"openclaw":{"emoji":"🖥️"}}
user-invocable: true
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# devcontainer — Ephemeral Code Server Dev Sessions

## Principle

Each session is an ephemeral Docker container with Code Server + OpenClaw.
Ephemeral = destroyed on `/dev release` or after 30min of inactivity.
Persistent = VSCode profile, extensions, OpenClaw config (per-user volumes).

## Commands

| Command | Action |
|---------|--------|
| `/dev create` | Start a dev session (empty workspace) |
| `/dev create owner/repo` | Start with a cloned Forgejo repo |
| `/dev create owner/repo --password mypass` | With password |
| `/dev release` | Close the session (auto-commit changes) |
| `/dev status` | Active sessions and URL |
| `/dev queue` | Position in the queue if VRAM is busy |

## /dev create Procedure

```bash
# The agent calls the orchestrator
curl -sf -X POST http://localhost:9001/dev/create \
  -H "Content-Type: application/json" \
  -d '{
    "userId":   "'$USER_ID'",
    "repo":     "'"${REPO:-}"'",
    "password": "'"${DEV_PASSWORD:-}"'"
  }'
```

The orchestrator:
1. Checks that there is no active session for this user
2. Checks VRAM availability
3. Spawns the container with Traefik labels for the ephemeral URL
4. Signals the scheduler: HUMAN_SHARED (agents continue if VRAM is available)
5. Returns the URL: `https://dev-abc123.example.com`

## What is ephemeral vs persistent

```
EPHEMERAL (container --rm):
  - All system packages installed during the session
  - node_modules, pip packages, build artifacts
  - Files outside /workspace and outside volumes

PERSISTENT (per-user Docker volumes):
  - ~/.config/Code/User/          <- settings, keybindings
  - ~/.local/share/code-server/   <- installed extensions
  - ~/.openclaw/                  <- gateway config, memory

PERSISTENT (git):
  - Code -> committed on Forgejo
  - Environment -> .devcontainer/devcontainer.json in the repo
```

## Devcontainer.json — modifying the environment between sessions

```json
// .devcontainer/devcontainer.json in the repo
{
  "name": "My project",
  "postCreateCommand": "npm install && pip install -r requirements.txt",
  "containerEnv": {
    "NODE_ENV": "development",
    "DATABASE_URL": "postgresql://localhost/mydb"
  },
  "forwardPorts": [3000, 8000]
}
```

The `postCreateCommand` is only executed once per version of devcontainer.json.
If you modify the file and commit, it will be re-executed on the next session.

## Heartbeat — avoiding idle timeout

Code Server automatically sends heartbeats every 5min to the orchestrator.
If no activity for 30min -> container stopped, changes auto-committed.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVCONTAINER_IMAGE` | `ghcr.io/pikatsuto/cdw-devcontainer:latest` | Base image |
| `DEVCONTAINER_MEMORY` | `4g` | RAM per session |
| `DEVCONTAINER_CPUS` | `2.0` | CPU per session |
| `DEV_DOMAIN` | `dev.example.com` | Domain for ephemeral URLs |
| `DEV_IDLE_MS` | `1800000` | Idle timeout (30min) |
