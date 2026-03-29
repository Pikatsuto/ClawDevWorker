# ClawDevWorker

**Your entire dev team, running on your own GPU.**

ClawDevWorker is an autonomous multi-agent development stack that turns a single server with a GPU into a complete software factory. Drop an issue, walk away — 12 specialist AI agents will analyze it, architect the solution, write the code, audit for security flaws, write tests, produce documentation, and open a clean PR for you to review. All of this happens on your hardware, with your models, behind your firewall. No cloud API, no per-token billing, no data leaving your infrastructure.

When you want to work alongside the agents, open a browser or connect your local VSCode via SSH — you get a full dev environment with the same AI stack available. The AI remembers what it learned across sessions. You can teach it new concepts interactively, and it will apply that knowledge automatically in future work.

This is not a chatbot wrapper. It's a self-hosted, GPU-optimized, multi-agent development platform with persistent memory, intelligent scheduling, and full pipeline automation.

---

## What it looks like in practice

**Autonomous mode** — You assign an issue to the agent on Forgejo or GitHub. The orchestrator reads your pipeline config, routes the issue to the right specialists, and runs them in sequence on a shared branch. Each specialist focuses on its expertise: the architect plans, the fullstack implements, security audits, QA writes tests, doc produces documentation. One clean PR comes out the other end. You review it, leave comments if needed (the agents will fix them automatically), and merge when satisfied.

**Interactive mode** — You type `/dev create owner/repo` in the chat. A Code Server instance spins up in seconds, accessible from your browser or your local VSCode via SSH. The AI assists you as you code, with access to the full documentation search engine, project memory, and specialist knowledge. When you're done, `/dev release` destroys the container — your VSCode profile and project data persist for next time.

**Learning mode** — You run `/ia-learning start` and teach the AI a new concept, framework, or workflow. It researches documentation, takes notes, and you validate before it saves. From then on, whenever that topic comes up in any conversation — chat, worker, or dev session — the AI silently recalls the relevant knowledge without you having to repeat yourself.

**When things go wrong** — If the AI gets stuck in a loop, `loop-detect` catches it. If a conversation derails, `/forget` cleans the context without starting over. If a gate fails 3 times, the system escalates to you with a detailed summary of what was tried. The AI never guesses, never hallucinates silently, never abandons a feasible task.

---

## Features

| Feature | Description |
|---------|-------------|
| **12 specialist agents** | architect, frontend, backend, fullstack, devops, security, qa, doc, marketing, design, product, bizdev — each with a dedicated system prompt and model |
| **RBAC pipeline** | Configurable per-project gate sequence, automatic retry with model upgrade, dependency DAG between issues |
| **Intelligent GPU scheduling** | VRAM cohabitation (human + agents), LRU keep-alive, next-gate preloading, dynamic upgrade/downgrade |
| **Persistent learning** | `/ia-learning` sessions with heuristic trigger matching + 0.8b real-time extraction for automatic context injection |
| **Controlled forgetting** | `/forget` removes messages from context — in interactive mode (user) and autonomous mode (loop recovery) |
| **Code Server + SSH** | Browser-based or local VSCode via SSH, with DinD for devcontainers, all AI tools available |
| **Documentation search** | 3-level cascade: 1000+ self-hosted docs (DevDocs) → official APIs → web scraping (SearXNG + nodriver) |
| **Multi-agent fan-out** | Decompose large tasks into subtasks, execute in parallel on separate branches, aggregate results |
| **Dual git provider** | Forgejo and GitHub App supported simultaneously |
| **Session handoff** | Save and resume sessions across chat, VSCode, and workers — shared via `project_data` volume |
| **Semantic memory** | Per-project SQLite memory shared across all surfaces |
| **Incremental codebase index** | AST-based index with git-diff updates, symbol search, impact radius analysis |
| **Network isolation** | Rootless containers, squid whitelist proxy, segmented networks, ephemeral by default |
| **TypeScript codebase** | Strict typing, ES2024, ESM imports, compiled with `tsc` 6 |
| **Hash-based CI** | Only changed services are rebuilt — per-container hash stored in GHCR |

---

## Architecture

```
                                    Internet
                                       |
                              [Coolify / Traefik]
                              /        |        \
                   chat.<domain>  dev-<id>.<domain>  forgejo/github
                        |              |                   |
                 +-----------+  +-----------+      +-----------+
                 |  Chat     |  | DevContainer|    |  Agent    |
                 |  DinD     |  | CodeServer |    |  DinD     |
                 |  stream-  |  | sshd       |    |  GPU sched|
                 |  proxy    |  | DinD       |    |  Orchestr.|
                 |  dev-mgr  |  | OpenClaw   |    |  Webhooks |
                 +-----------+  +-----------+      +-----------+
                        \           |              /
                    [backend network — internal]
                    /              |              \
             +--------+    +----------+     +--------+
             | Ollama |    | mcp-docs |     | Worker |
             | GPU    |    | DevDocs  |     | (ephem)|
             +--------+    | SearXNG  |     +--------+
             +--------+    | nodriver |
             | Ollama |    +----------+
             | CPU    |
             +--------+
```

### Services

| Service | Image | Role |
|---------|-------|------|
| `ollama` | `ollama/ollama` | GPU inference |
| `ollama-cpu` | `ollama/ollama` | CPU orchestration, routing, learn extraction |
| `openclaw-agent` | `cdw-agent` | GPU scheduler + pipeline orchestrator + webhooks |
| `openclaw-chat` | `cdw-chat` | Chat interface + commands + Ollama stream proxy |
| `devcontainer` | `cdw-devcontainer` | Code Server + SSH (dynamically spawned) |
| `worker` | `cdw-worker` | Ephemeral agent (one gate, one specialist, exit) |
| `devdocs` | `freecodecamp/devdocs` | Offline documentation (1000+ docsets) |
| `searxng` | `cdw-searxng` | Local search engine |
| `browserless` | `cdw-browserless` | Headless browser for web scraping |
| `mcp-docs` | `cdw-mcp-docs` | MCP documentation server (3-level cascade) |
| `cdw-squid` | `cdw-squid` | Outbound whitelist proxy |

### Networks

| Network | Access | Purpose |
|---------|--------|---------|
| `backend` | internal | Ollama GPU + CPU |
| `mcp-net` | internal | agents ↔ mcp-docs / devdocs / searxng / browserless |
| `proxy-internal-net` | internal | agents ↔ squid (whitelisted internet) |
| `proxy-net` | outbound | squid → internet |
| `coolify` | external | Coolify reverse proxy (Traefik) |

---

## Commands

### Project initialization

| Command | Action |
|---------|--------|
| `/spec init owner/repo` | Create repo, configure webhook + branch protection, run BMAD, generate issues |
| `/spec push owner/repo` | Push BMAD artifacts + create issues |

### Dev sessions

| Command | Action |
|---------|--------|
| `/dev create owner/repo` | Spawn Code Server + SSH with cloned repo |
| `/dev release` | Close the session |
| `/dev status` | Active sessions and URLs |

### AI learning

| Command | Action |
|---------|--------|
| `/ia-learning start` | Start a learning session |
| `/ia-learning review` | Validate notes before compilation |
| `/ia-learning stop "name"` | Compile into persistent learn |
| `/ia-learning list` | List project learns |
| `/ia-learning inject "name"` | Force-inject a learn into context |

### Context

| Command | Action |
|---------|--------|
| `/project select <name>` | Load project context |
| `/project status` | Current issues and PRs |
| `/handoff` | Save session state |
| `/resume latest` | Resume last session |
| `/remember <query>` | Search project memory |
| `/learn <fact>` | Memorize a decision |

### Codebase

| Command | Action |
|---------|--------|
| `/analyze` | Incremental index update (git-diff) |
| `/search <query>` | Search the index |
| `/impact <file>` | Impact radius before modification |

### Pipeline control (in issue/PR comments)

| Command | Action |
|---------|--------|
| `/stop` | Freeze the pipeline |
| `/retry` | Restart from current gate |
| (any comment on PR) | Re-triggers relevant gates |

### Forgetting

| Command | Action |
|---------|--------|
| `/forget preview` | Preview what will be deleted |
| `/forget last N` | Delete last N messages |
| `/forget since Xm` | Delete messages from the last X minutes |

### GPU

| Command | Action |
|---------|--------|
| `/gpu status` | Free VRAM, mode, active slots |
| `/wait-gpu` | Wait for a GPU slot (if CPU fallback) |

---

## GPU scheduling

### 3 cohabitation modes

| Mode | Behavior |
|------|----------|
| `AGENT_ACTIVE` | Agents run freely, all VRAM available |
| `HUMAN_SHARED` | Human active, agents continue if VRAM ≥ 2GB free |
| `HUMAN_EXCLUSIVE` | VRAM full, agents paused (queued) |

### Model selection

| Tier | Default model | Score range | VRAM |
|------|--------------|-------------|------|
| Complex | `qwen3.5:27b-q3_k_m` | ≥ 70 | 14GB |
| Standard | `qwen3.5:9b` | 30–70 | 5GB |
| Light | `qwen3.5:4b` | 10–30 | 3GB |
| Trivial | `qwen3.5:2b` | < 10 | 2GB |
| CPU | `qwen3.5:0.8b` | fallback | 0GB |

### Optimizations

- **Keep-alive LRU**: top 2 idle models stay loaded in VRAM
- **Next-gate preload**: orchestrator pre-loads the next specialist's model while the current gate works
- **Dynamic upgrade/downgrade**: chat sessions propose model changes based on complexity streaks
- **CPU ambiguity check**: 0.8b arbitrates when the heuristic score falls in the grey zone

---

## Pipeline configuration

```yaml
# .coderclaw/rules.yaml
pipeline:
  gates: [architect, fullstack, security, qa, doc]
  require_all: true
  max_retries: 3
  retry_upgrade: true

specialists:
  architect:
    triggers: [architecture, adr, migration, refactoring, breaking change]
    model: qwen3.5:27b-q3_k_m
  security:
    triggers: [security, injection, xss, csrf, auth, password, token]
  frontend:
    triggers: [ui, ux, component, page, vue, react, responsive]
  # ... etc

releases:
  enabled: true
  strategy: conventional
  prefix: v
```

---

## Deployment

```bash
cp .env.example .env    # Fill in: domains, tokens, GPU config
docker compose up -d
docker compose logs ollama-init    # Verify model downloads
docker compose logs -f openclaw-agent    # Watch the agent
```

### Checklist

- [ ] Wildcard DNS `*.DEV_DOMAIN` → server IP
- [ ] Coolify configured for wildcard TLS
- [ ] `.env` filled
- [ ] `docker compose up -d`
- [ ] Models downloaded (`ollama-init`)
- [ ] Forgejo webhook → `http://openclaw-agent:9000/webhook`
- [ ] Branch protection on `main` (1 required approval)
- [ ] `.coderclaw/rules.yaml` in each target repo

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_DOMAIN` | — | Chat domain |
| `DEV_DOMAIN` | — | Wildcard domain for dev sessions |
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
| `MODEL_<ROLE>` | — | Per-role override |
| `GATE_MAX_RETRIES` | `3` | Retries before human escalation |
| `KEEPALIVE_MAX` | `2` | Idle models kept in VRAM |

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

---

## IDE compatibility

| Access | Condition | Compatible |
|--------|-----------|------------|
| Browser (Code Server) | always | all browsers |
| VS Code Desktop | `/ssh-key` configured | Remote-SSH |
| Cursor | `/ssh-key` configured | Remote-SSH |
| Windsurf | `/ssh-key` configured | Remote-SSH |
| JetBrains Gateway | `/ssh-key` configured | Native SSH |

---

## Tech stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict, ES2024, ESM) |
| Runtime | Node.js 24 LTS |
| Build | tsc (TypeScript 6) |
| Containers | Docker rootless, Alpine |
| LLM | Ollama (local GPU) |
| Agent framework | OpenClaw |
| Git providers | Forgejo + GitHub App |
| Reverse proxy | Coolify (Traefik) |
| Documentation | DevDocs + mcp-docs |
| Web search | SearXNG + nodriver |
| CI/CD | GitHub Actions (per-container hash-based rebuild) |

---

## License

ISC