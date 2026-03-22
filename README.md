# ClawDevWorker

Autonomous multi-agent development stack: ephemeral Code Server + Ollama + specialist OpenClaw agents on local GPU.

Agents receive Forgejo or GitHub issues, analyze them, code, review through an RBAC pipeline, and open PRs — without human intervention. Humans retain control via the chat and interactive Code Server sessions.

---

## Architecture

```
Internet
 └── chat.example.com          → Coolify → openclaw-chat
 └── dev-<id>.DEV_DOMAIN       → Coolify → ephemeral Code Server container
 └── ssh.dev-<id>.DEV_DOMAIN   → Coolify → container sshd (if /ssh-key configured)
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

Each specialist has a dedicated system prompt. Routing priority: git labels (manual override) → trigger matching (rules.yaml keywords vs issue text) → CPU disambiguation → ask human.

Per-specialist model defaults:
- **Reasoning** (architect, security) → `qwen3.5:27b-q3_k_m`
- **Code** (fullstack, backend, frontend, devops, qa) → `qwen3.5:9b`
- **Writing** (doc, marketing, design, product, bizdev) → `mistral:7b`

Override per role via `MODEL_<ROLE>` env var or `model:` field in rules.yaml.

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

### Git flow

```
feat/42-dark-mode (shared branch, all gates commit here)
  ├── architect commits (ADR, decomposition)
  ├── fullstack commits (implementation)
  ├── security commits (fixes found by audit)
  ├── qa commits (tests)
  └── doc commits (documentation)
→ Single PR: feat/42-dark-mode → main
→ Human reviews and merges
→ auto-promote creates promotion PR if gitflow enabled
→ auto-release creates tag + changelog from conventional commits
```

Configurable in `.coderclaw/rules.yaml`:
```yaml
git_flow:
  strategy: trunk          # trunk | gitflow
  target_branch: main

releases:
  enabled: true
  strategy: conventional   # conventional | manual
  prefix: v
```

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
/spec init owner/repo               → /rules → BMAD → PRD + Architecture + User Stories → issues
/spec init owner/repo --provider github  → same, on GitHub instead of Forgejo
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

### Pipeline rules

```
/rules                              → interactive pipeline configuration
/rules owner/repo                   → configure rules for a specific repo
```

### Branch cleanup

```
/clean                              → interactive branch cleanup (current project)
/clean owner/repo                   → cleanup branches on a specific repo
```

### Pipeline control (in issue/PR comments)

```
/stop                               → freeze the pipeline on this issue
/retry                              → restart the pipeline from current gate
(any comment on a PR)               → auto-triggers relevant gates
(comment on merged PR)              → resumes work on the same branch
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
| `MODEL_<ROLE>` | — | Per-role override (e.g. `MODEL_SECURITY=qwen3.5:27b-q3_k_m`) |
| `MODEL_WRITING` | `mistral:7b` | Default model for writing roles (doc, marketing, design, product, bizdev) |
| `DEVCONTAINER_IMAGE` | `cdw-devcontainer:latest` | Dev session image |
| `DEVCONTAINER_MEMORY` | `4g` | RAM per session |
| `DEVCONTAINER_CPUS` | `2.0` | CPUs per session |
| `DEV_IDLE_MS` | `1800000` | Idle timeout (30min) |
| `DEV_NETWORK` | `coolify` | Docker network shared with Coolify |
| `GATE_MAX_RETRIES` | `3` | Retries before human escalation |
| `LOOP_DETECT_THRESHOLD` | `2` | Repeated hash → loop detected |
| `UPGRADE_THRESHOLD` | `30` | Score delta before upgrade suggestion |
| `DOWNGRADE_STREAK_MAX` | `3` | Consecutive low messages before downgrade |

---

## Deployment checklist

- [ ] Wildcard DNS `*.DEV_DOMAIN` → server IP
- [ ] Coolify configured for wildcard TLS
- [ ] `.env` filled from `.env.example`
- [ ] `docker compose up -d`
- [ ] `docker compose logs ollama-init` → models downloaded
- [ ] DevDocs: downloads automatically when agents search for missing documentation
- [ ] Forgejo webhook → `http://openclaw-agent:9000/webhook`
- [ ] Branch protection on `main` (Required approvals: 1)
- [ ] `.coderclaw/rules.yaml` in each target repo

---

## Webhook setup

### Forgejo

1. Go to the repo → **Settings → Webhooks → Add Webhook → Gitea**
2. Target URL: `http://openclaw-agent:9000/webhook`
3. Content Type: `application/json`
4. Secret: same as `GIT_PROVIDER_1_WEBHOOK_SECRET` in `.env`
5. Events: **Issues**, **Issue Comments**, **Pull Requests**
6. Active: ✅

> `/spec init` configures the webhook automatically for new repos.

### GitHub

GitHub uses a **GitHub App** instead of simple webhooks:

1. Create a GitHub App at **Settings → Developer Settings → GitHub Apps → New**
2. App permissions:
   - **Repository**: Issues (read/write), Pull requests (read/write), Contents (read)
   - **Organization**: Members (read)
3. Subscribe to events: **Issues**, **Issue comment**, **Pull request**
4. Generate a private key and base64-encode it:
   ```bash
   base64 -w0 < your-app.private-key.pem
   ```
5. Install the App on the target repos
6. Set env vars in `.env`:
   ```
   GIT_PROVIDER_2=github
   GIT_PROVIDER_2_APP_ID=<app-id>
   GIT_PROVIDER_2_PRIVATE_KEY_B64=<base64-encoded-key>
   GIT_PROVIDER_2_INSTALLATION_ID=<installation-id>
   GIT_PROVIDER_2_WEBHOOK_SECRET=<webhook-secret>
   ```
7. In the GitHub App settings, set the webhook URL to the agent's public URL

> GitHub App webhooks are configured at the app level, not per-repo.

---

## Branch protection

`/spec init` configures branch protection automatically. To do it manually:

### Forgejo

1. Repo → **Settings → Branches → Add Rule**
2. Branch pattern: `main`
3. ✅ Enable push restriction
4. ✅ Enable merge whitelist
5. Required approvals: **1**
6. ✅ Dismiss stale approvals

### GitHub

1. Repo → **Settings → Branches → Add branch protection rule**
2. Branch name pattern: `main`
3. ✅ Require a pull request before merging
4. Required approving reviews: **1**
5. ✅ Dismiss stale pull request approvals

---

## .coderclaw/rules.yaml

`/spec init` creates a default `rules.yaml`. The `/rules` command provides an interactive session to customize it. To edit manually:

```yaml
# .coderclaw/rules.yaml
pipeline:
  gates: [architect, fullstack, security, qa, doc]
  require_all: true        # false = parallel gates
  max_retries: 3           # retries before human escalation
  retry_upgrade: true      # upgrade model on retry

releases:
  enabled: true
  strategy: conventional   # conventional | manual
  prefix: v

specialists:
  architect:
    triggers: [architecture, adr, migration, refactoring, breaking change]
    model: qwen3.5:27b-q3_k_m
    fallback: qwen3.5:9b
  security:
    triggers: [security, injection, xss, csrf, auth, password, token]
    model: qwen3.5:27b-q3_k_m
    fallback: qwen3.5:9b
  frontend:
    triggers: [ui, ux, component, page, vue, react, responsive]
  backend:
    triggers: [api, endpoint, auth, database, migration, sql, cache]
  devops:
    triggers: [docker, ci, cd, deploy, monitoring]
  security:
    triggers: [security, injection, xss, csrf, auth, password, token]
  qa:
    triggers: [test, spec, e2e, coverage, regression, bug, fix]
  doc:
    triggers: [documentation, readme, jsdoc, changelog, guide]
  marketing:
    triggers: [seo, landing, conversion, copy]
  design:
    triggers: [branding, color, typography, mockup, accessibility]
  product:
    triggers: [prd, user story, acceptance, roadmap, backlog]
  bizdev:
    triggers: [pricing, subscription, go-to-market, partnership]
```

Only listed gates run. Specialists not in `gates` are available for routing but won't block the pipeline.

---

## IDE compatibility

| Access | Condition | Compatible |
|--------|-----------|------------|
| Browser (Code Server) | always | all browsers |
| VS Code Desktop | `/ssh-key` configured | Remote-SSH |
| Cursor | `/ssh-key` configured | Remote-SSH |
| Windsurf | `/ssh-key` configured | Remote-SSH |
| JetBrains Gateway | `/ssh-key` configured | Native SSH |
