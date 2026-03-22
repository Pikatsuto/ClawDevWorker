# ClawDevWorker v14

Autonomous multi-agent development stack: ephemeral Code Server + Ollama + specialist OpenClaw agents on local GPU.

Agents receive Forgejo or GitHub issues, analyze them, code, review through an RBAC pipeline, and open PRs — without human intervention. Humans retain control via the chat and interactive Code Server sessions.

---

## Architecture

```
Internet
 └── chat.example.com          → Traefik → openclaw-chat
 └── dev-<id>.DEV_DOMAIN       → Traefik → ephemeral Code Server container
 └── ssh.dev-<id>.DEV_DOMAIN   → Traefik → container sshd (if /ssh-key configured)
```

### Dev sessions — ephemeral vs persistent

```
EPHEMERAL (--rm, destroyed on /dev release or 30min idle):
  System packages, node_modules, build artifacts

PERSISTENT (per-user volumes):
  VSCode profile (settings, keybindings)
  Installed extensions
  OpenClaw config + SSH key

PERSISTENT (git):
  Code → Forgejo / GitHub
  Environment → .devcontainer/devcontainer.json in the repo

PERSISTENT (shared project_data volume):
  Per-project semantic memory (SQLite)
  Session handoffs
  Incremental codebase index
```

### GPU scheduler — 3 cohabitation modes

```
AGENT_ACTIVE     → autonomous agents free, all VRAM available
HUMAN_SHARED     → dev session active, agents continue if VRAM ≥ 2GB free
HUMAN_EXCLUSIVE  → VRAM full, agents paused (queued)
```

Model upgrade/downgrade:
- **Chat / Code Server** — suggestion displayed in session, `/upgrade` or `/downgrade` to confirm
- **Autonomous worker** — silent upgrade/downgrade based on complexity score

### 12 specialist agents

**Technical:** `architect` `frontend` `backend` `fullstack` `devops` `security` `qa` `doc`

**Business:** `marketing` `design` `product` `bizdev`

Each specialist has a dedicated system prompt. The CPU analyzes the issue and determines the required specialists. Forgejo/GitHub labels serve as manual override.

### Per-project configurable RBAC pipeline

```yaml
# .coderclaw/rules.yaml in each repo
pipeline:
  gates: [architect, fullstack, security, qa, doc]
  require_all: true
  max_retries: 3
  retry_upgrade: true
```

Unlisted gates = ignored. `require_all: false` = parallel gates without blocking.

### Issue dependency DAG

```markdown
## US-003 — Dashboard
**Depends on:** US-001, US-002
```

The orchestrator waits for US-001 and US-002 to be `Done` before starting US-003.

### Human brain model

```
Amygdala    → loop-detect + handleGateFail + escalateToHuman
Hippocampus → semantic-memory + session-handoff + incremental codebase-index
Cortex      → orchestrator + GPU scheduler + routing 12 specialists + DAG + RBAC
```

---

## Main commands

### Dev sessions

```
/dev create owner/repo              → ephemeral Code Server with cloned repo
/dev create owner/repo --password   → with authentication
/dev release                        → close the session
/dev status                         → active sessions and URLs
```

If `/ssh-key` is configured, each session also exposes SSH access compatible with VS Code Desktop, Cursor, Windsurf and JetBrains Gateway.

### SSH key (native IDE access)

```
/ssh-key set <public_key>           → save for all sessions
/ssh-key status                     → check if configured
/ssh-key clear                      → remove
```

### Project initialization

```
/spec init owner/repo               → BMAD → PRD + Architecture + User Stories → Forgejo issues
/spec status owner/repo             → pipeline status
```

### User git token

```
/token set <token>                  → personal token (to create repos on your account)
/token status
/token clear
```

### Project context

```
/project select <name>              → load memory + handoff + rules
/project status                     → current issues and PRs
/project code                       → read-only code
/project list                       → list projects
```

### Session handoff

```
/handoff                            → save complete session state
/resume latest                      → resume the last session
/resume <id>                        → resume a specific session
```

### Semantic memory

```
/remember <query>                   → search project memory
/learn <fact>                       → memorize a decision
/memory list                        → recent entries
```

### Codebase

```
/analyze                            → incremental index update (git-diff)
/analyze --full                     → forced full scan
/search <query>                     → search the index
/impact <file>                      → impact radius before modification
```

### Staged diff (interactive sessions)

```
/diff                               → show pending changes
/diff src/auth.ts                   → diff a single file
/accept                             → atomic commit of all changes
/accept src/auth.ts                 → commit a single file
/reject                             → discard all changes
```

### GPU

```
/gpu status                         → free VRAM, mode, active slots
/gpu models                         → available models
```

---

## Devcontainer.json

Add `.devcontainer/devcontainer.json` to the repo to customize the environment:

```json
{
  "name": "My project",
  "postCreateCommand": "npm install",
  "containerEnv": { "NODE_ENV": "development" },
  "forwardPorts": [3000, 5173]
}
```

`postCreateCommand` runs once per file version. Modify + commit → re-executed on the next session.

---

## Services

| Service | Image | Role |
|---------|-------|------|
| `ollama` | `ollama/ollama:latest` | GPU (RTX 2080 Ti + GTX 1660) |
| `ollama-cpu` | `ollama/ollama:latest` | CPU orchestration |
| `ollama-init` | `cdw-ollama-init:latest` | Model download (ephemeral) |
| `openclaw-agent` | `cdw-agent:latest` | Scheduler + orchestrator + webhooks |
| `openclaw-chat` | `cdw-chat:latest` | Chat interface + commands |
| `devcontainer` | `cdw-devcontainer:latest` | Code Server sessions (dynamically spawned) |
| `devdocs` | `freecodecamp/devdocs` | Offline documentation |
| `searxng` | `cdw-searxng:latest` | Local search engine |
| `browserless` | `cdw-browserless:latest` | Headless browser |
| `mcp-docs` | `cdw-mcp-docs:latest` | MCP documentation server |
| `cdw-squid` | `cdw-squid:latest` | Agent outbound proxy |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_DOMAIN` | — | openclaw-chat domain |
| `DEV_DOMAIN` | — | Wildcard domain for dev sessions (`*.DEV_DOMAIN`) |
| `OPENCLAW_GATEWAY_PASSWORD` | — | Chat password |
| `GIT_PROVIDER_1` | `forgejo` | Provider 1 type |
| `GIT_PROVIDER_1_URL` | — | Forgejo URL |
| `GIT_PROVIDER_1_TOKEN` | — | Agent account token |
| `GIT_PROVIDER_2` | — | `github` if GitHub App enabled |
| `GIT_PROVIDER_2_APP_ID` | — | GitHub App ID |
| `GIT_PROVIDER_2_PRIVATE_KEY_B64` | — | GitHub App private key (base64) |
| `AGENT_GIT_LOGIN` | `agent` | Agent git account login |
| `MODEL_COMPLEX` | `qwen3.5:27b-q3_k_m` | Score ≥ 70 |
| `MODEL_STANDARD` | `qwen3.5:9b` | Score 30–70 |
| `MODEL_LIGHT` | `qwen3.5:4b` | Score 10–30 |
| `MODEL_TRIVIAL` | `qwen3.5:2b` | Score < 10 |
| `MODEL_CPU` | `qwen3.5:0.8b` | CPU orchestration |
| `MODEL_<ROLE>` | — | Per-role override (e.g. `MODEL_MARKETING=mistral:7b`) |
| `DEVCONTAINER_IMAGE` | `cdw-devcontainer:latest` | Dev session image |
| `DEVCONTAINER_MEMORY` | `4g` | RAM per session |
| `DEVCONTAINER_CPUS` | `2.0` | CPUs per session |
| `DEV_IDLE_MS` | `1800000` | Idle timeout (30min) |
| `DEV_NETWORK` | `coolify` | Docker network for Traefik |
| `GATE_MAX_RETRIES` | `3` | Retries before human escalation |
| `LOOP_DETECT_THRESHOLD` | `2` | Repeated hash → loop detected |
| `UPGRADE_THRESHOLD` | `30` | Score delta before upgrade suggestion |
| `DOWNGRADE_STREAK_MAX` | `3` | Consecutive low messages before downgrade |

---

## Deployment checklist

- [ ] Wildcard DNS `*.DEV_DOMAIN` → server IP
- [ ] Traefik configured for wildcard TLS
- [ ] `.env` filled from `.env.example`
- [ ] `docker compose up -d`
- [ ] `docker compose logs ollama-init` → models downloaded
- [ ] DevDocs: `docker compose exec devdocs thor docs:download javascript`
- [ ] Forgejo webhook → `http://openclaw-agent:9000/webhook`
- [ ] Branch protection on `main` (Required approvals: 1)
- [ ] `.coderclaw/rules.yaml` in each target repo

---

## IDE compatibility

| Access | Condition | Compatible |
|--------|-----------|------------|
| Browser (Code Server) | always | all browsers |
| VS Code Desktop | `/ssh-key` configured | Remote-SSH |
| Cursor | `/ssh-key` configured | Remote-SSH |
| Windsurf | `/ssh-key` configured | Remote-SSH |
| JetBrains Gateway | `/ssh-key` configured | Native SSH |
