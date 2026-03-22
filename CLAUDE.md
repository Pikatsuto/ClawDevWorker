# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawDevWorker is an autonomous multi-agent development stack. Agents receive issues from Forgejo/GitHub, analyze them, code solutions through a specialist pipeline, and open PRs — all without human intervention. Humans interact via chat, Code Server sessions, and PR reviews.

Code is **Node.js/JavaScript**. All services are containerized. No local build step — images are built by CI and pushed to GHCR (`ghcr.io/pikatsuto/cdw-<service>`).

## Build & Deploy

```bash
docker compose up -d                          # Start the full stack
docker compose logs ollama-init               # Check model downloads
docker compose logs -f openclaw-agent         # View agent logs
```

CI (`.github/workflows/build.yml`) dynamically discovers `services/*/Dockerfile`, analyzes COPY sources to determine which services need rebuilding, and skips unchanged ones.

There are no test suites or linters configured at the repo level.

## Architecture

### Single-PR Pipeline (Orchestrator v3)

One issue = one branch = one PR. All specialist gates run sequentially on the same branch:

```
Issue #42 assigned → orchestrator reads rules.yaml → creates feat/42-dark-mode
  → architect commits (ADR, decomposition)
  → fullstack commits (implementation)
  → security commits (audit fixes)
  → qa commits (tests)
  → doc commits (documentation)
→ Single clean PR submitted to human
→ Human reviews, comments trigger re-run of relevant gates
→ Human merges → auto-promote → auto-release tag
```

### Specialist Routing

Priority order:
1. **Git labels** (`gate:security` on the issue) — manual override
2. **Trigger matching** (issue text vs specialist triggers in rules.yaml)
3. **CPU disambiguation** (0.8b model narrows candidates when >3 triggers match)
4. **Ask human** (comment + `needs-routing` label when no confidence)

### Per-Specialist Model Selection

| Family | Roles | Default Model |
|--------|-------|---------------|
| Reasoning | architect, security | `qwen3.5:27b-q3_k_m` |
| Code | fullstack, backend, frontend, devops, qa | `qwen3.5:9b` |
| Writing | doc, marketing, design, product, bizdev | `mistral:7b` |
| CPU | orchestration, routing | `qwen3.5:0.8b` |

Override via `MODEL_<ROLE>` env var or `model:` field per specialist in rules.yaml.

### Conversation-Driven Flow

- **Issue comment** before work → agent discusses, asks questions, waits for go
- **PR comment** after work → auto-triggers relevant gates for fixes
- **`/stop`** → freezes pipeline until next human comment
- **Post-merge comment** → resumes on same branch
- **`/retry`** → restarts from current gate

### Git Flow

Configurable in `.coderclaw/rules.yaml`:
- `trunk` (default): PR → main
- `gitflow`: PR → develop, auto-promote to main via tags

Branches are preserved on the user repo after merge. Agent can re-fork and continue from any existing branch.

Auto-release: conventional commits (`feat:`, `fix:`, `feat!:`) → SemVer tags + changelog.

### Network Segmentation

- `backend` (internal) — Ollama GPU + CPU
- `mcp-net` (internal) — agents ↔ mcp-docs/devdocs/searxng/browserless
- `proxy-internal-net` (internal) — agents ↔ squid only (whitelist internet)
- `proxy-net` — squid → internet
- `coolify` (external) — Coolify reverse proxy (uses Traefik internally)
- `docs-net` — documentation services

Workers join `backend` + `mcp-net` + `proxy-internal-net`. No direct internet access.

### GPU Scheduling (3 modes)

- **AGENT_ACTIVE** — Full VRAM for agents
- **HUMAN_SHARED** — Dev session active; agents continue if ≥2GB free
- **HUMAN_EXCLUSIVE** — VRAM saturated; agents queued

### Documentation Search (mcp-docs)

Three-level cascade, each level excludes what previous levels cover:
1. **DevDocs** (self-hosted, zero external network) — auto-downloads missing languages via CPU detection
2. **Official APIs** (npm, pypi, crates.io, GitHub) — only domains NOT in DevDocs
3. **SearXNG + nodriver** (web scraping) — only sites tolerating scraping, NOT in levels 1-2

### Worker Autonomy

Workers have full context: specialist role, pipeline position, git flow config, BMAD context. They follow a strict protocol:
- **Research first** (mcp-docs → existing code → tests → ask human last)
- **Never hallucinate** — factual only, fine to say "not feasible"
- **Never lazy** — complete the task regardless of workload
- **Never abandon** — persist, try different strategies, escalate after 3 failures

## Key Source Locations

| Component | Path |
|-----------|------|
| Orchestrator v3 | `services/agent/orchestrator/index.js` |
| GPU scheduler | `services/agent/gpu-scheduler/index.js` |
| Specialist prompts | `services/agent/specialists/*.md` |
| Worker startup | `services/worker/scripts/run-worker.sh` |
| Worker config gen | `services/worker/scripts/gen-config.js` |
| Git provider abstraction | `services/git-provider/` |
| Spec init (chat) | `services/chat/scripts/spec/spec-init.js` |
| Issue creator | `services/worker/skills/spec-init/create-issues.js` |
| Sub-agent fanout | `services/worker/skills/agent-fanout/scripts/` |
| Dev manager | `services/chat/scripts/dev-manager.js` |
| Stream proxy | `services/chat/scripts/stream-proxy.js` |
| MCP docs server | `services/mcp-docs/src/index.js` |
| Rules template | `services/devcontainer/defaults/coderclaw-rules.yaml` |
| Workflow templates | `services/devcontainer/defaults/workflows/` |
| Devcontainer config | `services/devcontainer/defaults/devcontainer.json` |

## Git Provider Abstraction

Dual Forgejo + GitHub App support via `services/git-provider/`:

**Worker operations** (agent token): createBranch, forkRepo, listBranches, createPR, addComment, setLabel, removeLabel, closeIssue, getIssue, getPR, getPRDiff, getFileContent, listRepoFiles, cloneUrl

**Privileged operations** (user token, chat/codeserver only, human confirmation required): createRepo, addCollaborator, createWebhook, protectBranch, deleteBranch

**Worker has NO access to privileged operations.**

## Conventions

- **Ephemeral by default**: Workers, sessions, build containers use `--rm`
- **Single PR per issue**: All gates commit on the same branch
- **Network isolation**: Worker internet goes through squid whitelist only
- **Config via env vars**: No bind mounts. `MODEL_<ROLE>` overrides per specialist
- **Conventional commits**: `feat:`, `fix:`, `refactor:`, `test:`, `docs:` — used for auto-release
- **Branch preservation**: Feature branches kept on user repo after merge for resume capability
- **Research first**: All surfaces search mcp-docs before asking the human
- **External networks required**: `coolify` and `forgejo-net` must pre-exist (created by Coolify/Forgejo)
