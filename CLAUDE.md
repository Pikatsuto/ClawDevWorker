# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawDevWorker is an autonomous multi-agent development stack that combines ephemeral Code Server sessions, Ollama LLM inference, and 12 specialist agents to automate code review, development, and QA workflows. Agents receive issues from Forgejo/GitHub, analyze them, code solutions, run pipeline gates, and open PRs without human intervention. Humans interact via chat and ephemeral Code Server sessions.

Code is **Node.js/JavaScript**.

## Build & Deploy

All services are containerized. There is no local build step — images are built by CI and pushed to GHCR (`ghcr.io/pikatsuto/cdw-<service>`).

```bash
# Start the full stack
docker compose up -d

# Check model downloads completed
docker compose logs ollama-init

# View logs for a specific service
docker compose logs -f openclaw-agent
```

CI pipeline (`.github/workflows/build.yml`) triggers on pushes to `main` touching `services/**`. It dynamically discovers all `services/*/Dockerfile` and builds them in a matrix.

There are no test suites or linters configured at the repo level.

## Architecture

### Service Topology

11 containerized services orchestrated via Docker Compose:

- **openclaw-agent** — Webhook-triggered autonomous agent. Receives Forgejo/GitHub issues, routes to specialists, manages pipeline gates. Runs DinD rootless for isolated code execution. Port 9000.
- **openclaw-chat** — Interactive chat gateway on port 18791. Manages ephemeral Code Server spawning. Read-only git access (no autonomous PRs).
- **ollama / ollama-cpu** — GPU and CPU LLM inference respectively. Qwen 3.5 model family at various quantizations.
- **devcontainer** — Spawned dynamically (not a fixed service). Ephemeral Code Server sessions with wildcard DNS routing (`dev-<id>.<DEV_DOMAIN>`).
- **Supporting**: devdocs (docs browser), searxng (local search), browserless (headless browser), mcp-docs (MCP documentation server), squid (outbound proxy with whitelist), ollama-init (one-shot model downloader).

### Network Segmentation

Services communicate through isolated Docker networks: `frontend` (public), `backend` (internal, LLM), `docs-net`, `mcp-net` (agents to MCP tools), `proxy-net`/`proxy-internal-net` (squid outbound), plus external networks `coolify` (Coolify uses Traefik internally) and `forgejo-net`.

### GPU Scheduling (3 modes)

The GPU scheduler (`services/agent/gpu-scheduler/index.js`, ~1500 lines) manages VRAM allocation:

- **AGENT_ACTIVE** — Full VRAM for agents
- **HUMAN_SHARED** — Dev session active; agents continue if >=2GB free
- **HUMAN_EXCLUSIVE** — VRAM saturated; agents queued

Model selection by complexity score: COMPLEX (>=70, 27b, 14GB), STANDARD (30-70, 9b, 5GB), LIGHT (10-30, 4b, 3GB), TRIVIAL (<10, 2b, 2GB), CPU (0.8b).

### Orchestrator & Pipeline

The orchestrator (`services/agent/orchestrator/index.js`, ~350 lines) executes specialist gates as a DAG. Pipeline configuration lives in `.coderclaw/rules.yaml` per target repo. Gates run sequentially (or parallel if `require_all: false`), with auto-retry and model upgrade on failure, escalating to human after `max_retries`.

### 12 Specialist Agents

System prompts in `services/agent/specialists/*.md`. **Technical:** architect, frontend, backend, fullstack, devops, security, qa, doc. **Business:** marketing, design, product, bizdev. Routing is based on issue complexity analysis + keyword triggers defined in `.coderclaw/rules.yaml`.

## Key Source Locations

| Component | Path |
|-----------|------|
| GPU scheduler | `services/agent/gpu-scheduler/index.js` |
| Orchestrator | `services/agent/orchestrator/index.js` |
| Specialist prompts | `services/agent/specialists/*.md` |
| Agent skills | `services/agent/skills/` |
| Chat skills | `services/chat/skills/` |
| Worker skills | `services/worker/skills/` |
| Dev manager (Code Server spawner) | `services/chat/scripts/dev-manager.js` |
| Default devcontainer config | `services/devcontainer/defaults/devcontainer.json` |
| Default rules template | `services/devcontainer/defaults/coderclaw-rules.yaml` |

## Conventions

- **Ephemeral by default**: Workers, sessions, and build containers use `--rm`. Only user config, project data (SQLite), and git are persistent.
- **Network isolation**: Containers run with `--network none` for code execution. Outbound internet is whitelist-only via squid proxy.
- **Config via env vars**: No bind mounts of config files. All configuration through environment variables (see `.env.example`).
- **All healthchecked**: Long-running services have Docker healthchecks.
- **Atomic changes**: Staged diff model — changes are reviewed then committed atomically.
- **Loop detection**: Threshold-based detection of repeated failures, escalating to human.
- **External networks required**: Deployment needs pre-existing `coolify` and `forgejo-net` Docker networks (created by Coolify/Forgejo).
