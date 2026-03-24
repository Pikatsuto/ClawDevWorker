#!/usr/bin/env bash
###############################################################################
# start-agent.sh — Autonomous development agent (headless, DinD rootless)
#
# Trigger: Forgejo webhook (issue assigned to agent account)
# Flow:
#   1. Forgejo assigns an issue → webhook POST /webhook
#   2. Clones the repo, reads BMAD context if present in the repo
#   3. Posts clarifying questions as issue comments if needed, then stops
#   4. Codes in isolated ephemeral containers (--network none)
#   5. Opens a PR "Closes #N"
#   6. Responds to review comments on the PR
###############################################################################

set -euo pipefail

OPENCLAW_DIR="$HOME/.openclaw"
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"
WEBHOOK_PORT="${WEBHOOK_PORT:-9000}"
OLLAMA_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:27b-q3_k_m}"
FORGEJO_URL="${FORGEJO_URL:-http://host-gateway:${FORGEJO_HOST_PORT:-3000}}"
FORGEJO_TOKEN="${FORGEJO_TOKEN:-}"
COOLIFY_URL="${COOLIFY_URL:-http://host-gateway:${COOLIFY_HOST_PORT:-8000}}"
COOLIFY_PREVIEW_DOMAIN="${COOLIFY_PREVIEW_DOMAIN:-}"
PROXY_URL="http://agent-squid:3128"
EPHEMERAL_MEMORY="${EPHEMERAL_MEMORY:-1g}"
EPHEMERAL_CPUS="${EPHEMERAL_CPUS:-1.0}"
EPHEMERAL_TIMEOUT="${EPHEMERAL_TIMEOUT:-300}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

log() { echo "[agent] $(date '+%H:%M:%S') $*"; }

if [ -z "$FORGEJO_TOKEN" ]; then
    log "ERROR: FORGEJO_TOKEN not set."
    exit 1
fi

# ── 1. Start dockerd rootless ─────────────────────────────────────────────
log "Starting dockerd rootless..."
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p "$XDG_RUNTIME_DIR"

dockerd-rootless.sh --experimental --storage-driver=overlay2 \
    --iptables=false --ip6tables=false \
    > /tmp/dockerd-rootless.log 2>&1 &
DOCKERD_PID=$!

log "Waiting for Docker socket..."
for i in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
done
docker info >/dev/null 2>&1 || { log "ERROR: dockerd rootless failed to start"; exit 1; }
log "dockerd rootless ready (PID=$DOCKERD_PID)"

# ── 2. Pre-pull ephemeral images ──────────────────────────────────────────
log "Pre-pulling ephemeral images..."
for img in python:3.12-slim node:24-slim ubuntu:24.04 bash:5; do
    docker image inspect "$img" >/dev/null 2>&1 \
        && log "  $img — already present" \
        || { log "  Pulling $img..."; docker pull "$img" 2>/dev/null && log "  $img — OK" || log "  $img — failed (ignored)"; }
done

# ── 3. Squid whitelist ──────────────────────────────────────────────────────
log "Generating Squid whitelist..."
export COOLIFY_PREVIEW_DOMAIN
node << 'NODESCRIPT'
const fs = require('fs');

const lines = [
  '# Agent whitelist — generated at startup',
  '',
  '# Package managers',
  'pypi.org',
  'files.pythonhosted.org',
  'registry.npmjs.org',
  'deb.nodesource.com',
  'dl.yarnpkg.com',
  'registry.yarnpkg.com',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  '',
  '# GitHub',
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  '',
  '# Ephemeral Docker images',
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
  'index.docker.io',
];

const previewDomain = process.env.COOLIFY_PREVIEW_DOMAIN || '';
if (previewDomain) {
  lines.push('', '# Ephemeral Coolify previews');
  lines.push('.' + previewDomain);
  lines.push('sslip.io');
}

const dir  = '/etc/squid/whitelist';
const file = dir + '/whitelist.conf';
try {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const domains = lines.filter(l => l && !l.startsWith('#')).length;
  console.log('whitelist.conf written (' + domains + ' domains) → ' + file);
} catch (e) {
  console.error('ERROR writing whitelist:', e.message);
  process.exit(1);
}
NODESCRIPT

docker exec agent-squid squid -k reconfigure 2>/dev/null \
    && log "agent-squid reloaded" \
    || log "agent-squid unreachable — will be active on next startup"

# ── 4. Skills ─────────────────────────────────────────────────────────────
mkdir -p "$OPENCLAW_DIR/skills"

for skill in docker-exec loop-detect session-handoff semantic-memory project-context frontend-design staged-diff forget; do
    if [ -d "/opt/skills/${skill}" ]; then
        log "Installing/updating skill ${skill}..."
        cp -r "/opt/skills/${skill}" "$OPENCLAW_DIR/skills/${skill}"
    fi
done

export SCHEDULER_URL="${SCHEDULER_URL:-http://localhost:7070}"
export PROJECT_DATA_DIR="${PROJECT_DATA_DIR:-/projects}"
export SURFACE="agent"
export PROXY_URL="${PROXY_URL:-http://agent-squid:3128}"

# ── 5. Generate openclaw.json ─────────────────────────────────────────────
mkdir -p "$OPENCLAW_DIR"
chmod 700 "$OPENCLAW_DIR"
mkdir -p "$OPENCLAW_DIR/workspace/memory"
mkdir -p "$OPENCLAW_DIR/memory"
touch "$OPENCLAW_DIR/.onboarded"

if [ ! -f "$OPENCLAW_DIR/.gateway_token" ]; then
    node -e "require('fs').writeFileSync('$OPENCLAW_DIR/.gateway_token', require('crypto').randomBytes(32).toString('hex'))"
fi
GATEWAY_TOKEN=$(cat "$OPENCLAW_DIR/.gateway_token")

if [ ! -f "$CONFIG_FILE" ]; then
    log "Generating openclaw.json..."
    export CONFIG_FILE WEBHOOK_PORT GATEWAY_TOKEN OLLAMA_URL OLLAMA_MODEL PROXY_URL
    export FORGEJO_URL FORGEJO_TOKEN COOLIFY_URL COOLIFY_PREVIEW_DOMAIN
    export OPENCLAW_DIR EPHEMERAL_MEMORY EPHEMERAL_CPUS EPHEMERAL_TIMEOUT GITHUB_TOKEN
    export FORGEJO_HOST_PORT="${FORGEJO_HOST_PORT:-3000}"
    export COOLIFY_HOST_PORT="${COOLIFY_HOST_PORT:-8000}"

    node << 'NODESCRIPT'
const fs   = require('fs');
const path = require('path');

const ollamaUrl     = process.env.OLLAMA_URL    || 'http://ollama:11434';
const ollamaModel   = process.env.OLLAMA_MODEL  || 'qwen3.5:27b-q3_k_m';
const workspaceDir  = process.env.OPENCLAW_DIR  + '/workspace';
const proxyUrl      = process.env.PROXY_URL     || 'http://agent-squid:3128';
const forgejoUrl    = process.env.FORGEJO_URL   || 'http://host-gateway:3000';
const forgejoToken  = process.env.FORGEJO_TOKEN || '';
const previewDomain = process.env.COOLIFY_PREVIEW_DOMAIN || '';
const mem           = process.env.EPHEMERAL_MEMORY || '1g';
const cpus          = process.env.EPHEMERAL_CPUS   || '1.0';
const timeout       = process.env.EPHEMERAL_TIMEOUT|| '300';
const githubToken   = process.env.GITHUB_TOKEN  || '';
const fPort         = process.env.FORGEJO_HOST_PORT || '3000';
const cPort         = process.env.COOLIFY_HOST_PORT || '8000';

const previewLine = previewDomain
  ? `- Coolify previews: *.${previewDomain}`
  : '- Coolify previews: not configured (COOLIFY_PREVIEW_DOMAIN not set)';

const systemPrompt = `You are an autonomous development agent.

# How it works

You are triggered by a Forgejo webhook when an issue is assigned to you.
You work alone, without human interaction during execution.
You communicate ONLY via Forgejo comments (issue and PR).

# Process for each issue

1. Read the entire issue and its existing comments
2. If the repo contains BMAD files (docs/bmad/, .bmad/, bmad/ or similar),
   read them to understand the architecture, conventions and project context
3. If you have blocking questions before starting, comment on the issue
   and STOP — you will be re-triggered when the human responds
4. Create a branch: agent/issue-{number}-{title-slug}
5. Code in isolated ephemeral containers via docker-exec
6. Atomic commits with explicit messages
7. Open a PR with "Closes #{number}" in the description
8. If the PR receives review comments, resume on the same branch and respond

# Network architecture

Reachable hosts:
- ollama              → local LLM, sole inference provider
- host-gateway:${fPort}  → Forgejo (read issues, push branches, PR, comments)
- host-gateway:${cPort}  → Coolify (trigger previews only)
- mcp-docs            → technical documentation (devdocs, searxng, browserless)
${previewLine}

Internet via proxy ${proxyUrl} (strict whitelist, everything is logged):
- npm, pypi, crates.io, github.com and associated CDNs
- Ephemeral Docker images (docker.io)

Ephemeral containers: network none, ${mem} RAM, ${cpus} CPU, ${timeout}s max

# Research — ALWAYS search before asking

You have access to mcp-docs for documentation search.
The search cascade is: DevDocs (self-hosted) → official APIs → web (SearXNG + scraping).
ALWAYS search for answers yourself before asking the human:
1. Search mcp-docs for relevant documentation
2. If no result, search with different keywords or broader terms
3. Read existing code in the repo for patterns and conventions
4. Check existing tests for expected behavior
5. Only if none of the above resolves your question → ask the human

The human is your LAST resort, not your first.

# Work ethic

- It is NORMAL to not know something. Search for answers, and if you cannot find them, say so honestly.
- NEVER hallucinate or invent information. If unsure, say "based on my research, I could not confirm this".
- It is perfectly fine to say: "this is not compatible", "this is not feasible", "this cannot be done legally".
  What matters is being FACTUAL, not optimistic.
- NEVER be lazy. If the task is requested and feasible, do it completely regardless of workload.
- NEVER abandon a task that is possible. Persistence is mandatory.
- If you are truly stuck after research, ask for help — that is normal and expected.
- NEVER loop endlessly on a failing approach. If something fails 3 times, try a different strategy.
  If all strategies fail, escalate to the human with what you tried and why it failed.

# Absolute limits

- You NEVER merge a PR yourself
- You NEVER deploy to production directly
- You NEVER modify infrastructure configuration
- When truly blocked after research, comment on the issue and wait

# Resuming work on existing branches

When asked to continue work on an existing issue or branch:
1. Check if the branch already exists on the user's repo (features/xxx, feat/xxx, fix/xxx)
2. If it does, fork it and continue from where the previous agent left off
3. Read the existing commits and PR comments to understand the context
4. Create new commits on top of the existing work
5. PR back to the same branch on the user's repo`;

const config = {
  gateway: {
    mode: 'local',
    bind: '0.0.0.0',
    port: parseInt(process.env.WEBHOOK_PORT || '9000'),
    auth: { mode: 'token', token: process.env.GATEWAY_TOKEN },
    nodes: { autoApprove: false },
  },
  agents: {
    defaults: {
      provider: 'ollama',
      model: ollamaModel,
      workspace: workspaceDir,
      compaction: {
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: 'Session nearing compaction. Store durable memories now.',
          prompt: 'Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.',
        },
      },
      memorySearch: {
        enabled: true,
        sync: { watch: true },
        store: { path: `${workspaceDir}/../memory/{agentId}.sqlite` },
      },
      sandbox: {
        mode: 'docker',
        docker: {
          env: {
            HTTP_PROXY:  proxyUrl,
            HTTPS_PROXY: proxyUrl,
            NO_PROXY: 'localhost,127.0.0.1',
          },
        },
      },
    },
    list: [
      {
        id: 'dev-agent',
        name: 'Dev Agent',
        systemPrompt,
        provider: 'ollama',
        model: ollamaModel,
        tools: {
          allow: [
            'file.read', 'file.write', 'file.delete',
            'terminal', 'git',
            'mcp-docs', 'docker-exec',
            'forgejo-mcp',
          ],
          deny: ['browser'],
        },
        mcpServers: {
          'mcp-docs': {
            transport: 'stdio',
            command: 'node',
            args: ['/opt/mcp-docs/src/index.js'],
            env: {
              DEVDOCS_URL:   'http://devdocs:9292',
              SEARXNG_URL:   'http://searxng:8080',
              NODRIVER_URL:  'http://browserless:3000',
              MAX_RESULTS:   '5',
              FETCH_TIMEOUT: '8000',
              ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
            },
          },
        },
        skills: { enabled: ['docker-exec', 'loop-detect', 'session-handoff', 'semantic-memory', 'project-context', 'frontend-design', 'staged-diff', 'forget'] },
      },
    ],
  },
  providers: {
    'ollama': { baseUrl: ollamaUrl },
  },
};

fs.mkdirSync(path.dirname(process.env.CONFIG_FILE), { recursive: true, mode: 0o700 });
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log('openclaw.json generated');
NODESCRIPT

else
    log "Existing config — token reloaded"
fi

# ── 6. Start the GPU Scheduler ────────────────────────────────────────────
log "Starting GPU Scheduler on :${SCHEDULER_PORT:-7070}..."
export SCHEDULER_PORT="${SCHEDULER_PORT:-7070}"
export HUMAN_IDLE_MS="${HUMAN_IDLE_MS:-1800000}"
export POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-15000}"
export OPENCLAW_AGENT_URL="http://localhost:${WEBHOOK_PORT}"

node /opt/gpu-scheduler/index.js &
GPU_SCHEDULER_PID=$!
log "GPU Scheduler started (PID=${GPU_SCHEDULER_PID})"

# ── 7. Start the Orchestrator
ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-9001}"
MEMORY_DIR="${OPENCLAW_DIR}/workspace/memory"
WORKER_IMAGE="${WORKER_IMAGE:-ghcr.io/pikatsuto/cdw-worker:latest}"

node /opt/orchestrator/index.js &
ORCHESTRATOR_PID=$!
log "Orchestrator started (PID=${ORCHESTRATOR_PID})"

# ── 8. Start the OpenClaw gateway (exec — replaces shell) ─────────────────────────────────────────
log "Starting OpenClaw gateway webhook on :${WEBHOOK_PORT}..."
log "→ Configure in Forgejo: Settings → Webhooks → http://openclaw-agent:${WEBHOOK_PORT}/webhook"

exec env \
    HTTP_PROXY="$PROXY_URL" \
    HTTPS_PROXY="$PROXY_URL" \
    NO_PROXY="localhost,127.0.0.1,ollama,devdocs,searxng,browserless,mcp-docs,agent-squid" \
    DOCKER_HOST="$DOCKER_HOST" \
    FORGEJO_TOKEN="$FORGEJO_TOKEN" \
    FORGEJO_URL="$FORGEJO_URL" \
    openclaw gateway start \
        --port "$WEBHOOK_PORT" \
        --bind "0.0.0.0" \
        --config "$CONFIG_FILE"

