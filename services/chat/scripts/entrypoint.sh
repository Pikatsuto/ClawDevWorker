#!/usr/bin/env bash
###############################################################################
# start-chat.sh — Interactive OpenClaw assistant (headless, DinD rootless)
#
# Fixes v2:
#   1. Squid whitelist generated dynamically from env vars (like agent)
#   2. deleteConfirmation removed (non-existent key) → security via tools.allow
#   3. HTTPS_PROXY explicitly passed to OpenClaw via env at launch
###############################################################################

set -euo pipefail

OPENCLAW_DIR="$HOME/.openclaw"
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18791}"
OLLAMA_URL="http://localhost:11435"  # local stream-proxy — dispatches via scheduler
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:27b-q3_k_m}"
OPENCLAW_GATEWAY_PASSWORD="${OPENCLAW_GATEWAY_PASSWORD:-}"
PROXY_URL="http://host-gateway:3128"
EPHEMERAL_MEMORY="${EPHEMERAL_MEMORY:-512m}"
EPHEMERAL_CPUS="${EPHEMERAL_CPUS:-0.5}"
EPHEMERAL_TIMEOUT="${EPHEMERAL_TIMEOUT:-60}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

log() { echo "[chat] $(date '+%H:%M:%S') $*"; }

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

# ── 3. Squid whitelist — generated dynamically from env vars ──────────────
# Shared volume squid_chat_whitelist mounted in:
#   openclaw-chat → /etc/squid/whitelist  (write)
#   chat-squid    → /etc/squid/whitelist  (read via squid-chat.conf)
log "Generating Squid whitelist..."
node << 'NODESCRIPT'
const fs = require('fs');

const lines = [
  '# Chat whitelist — generated at startup by start-chat.sh',
  '# Do not edit manually.',
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

// Path to shared volume with chat-squid
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

# Signal chat-squid to reload its config
docker exec chat-squid squid -k reconfigure 2>/dev/null \
    && log "chat-squid reloaded with new whitelist" \
    || log "chat-squid unreachable via docker exec — will be active on next startup"

# ── 4. Install skills ────────────────────────────────────────────────────
mkdir -p "$OPENCLAW_DIR/skills"

SKILL_DIR="$OPENCLAW_DIR/skills/docker-exec"
if [ ! -d "$SKILL_DIR" ]; then
    log "Installing docker-exec skill..."
    cp -r /opt/skills/docker-exec "$SKILL_DIR"
    log "docker-exec skill installed"
fi

# Skills updated on every startup
for skill in cpu-status loop-detect spec-init session-handoff semantic-memory project-context frontend-design staged-diff; do
    if [ -d "/opt/skills/${skill}" ]; then
        log "Installing/updating skill ${skill}..."
        cp -r "/opt/skills/${skill}" "$OPENCLAW_DIR/skills/${skill}"
    fi
done

# Environment variables for skills
export SCHEDULER_URL="${SCHEDULER_URL:-http://openclaw-agent:7070}"
AGENT_GIT_LOGIN="${AGENT_GIT_LOGIN:-agent}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://openclaw-agent:9001}"
export PROXY_URL="${PROXY_URL:-http://localhost:11435}"
export PROJECT_DATA_DIR="${PROJECT_DATA_DIR:-/projects}"
export SURFACE="chat"
export STAGED_MODE="${STAGED_MODE:-true}"

# ── 5. Generate openclaw.json ─────────────────────────────────────────────
mkdir -p "$OPENCLAW_DIR"
chmod 700 "$OPENCLAW_DIR"
# Create persistent directories at startup
# → guaranteed to survive restarts via the openclaw_chat_data volume
mkdir -p "$OPENCLAW_DIR/workspace/memory"   # daily logs YYYY-MM-DD.md
mkdir -p "$OPENCLAW_DIR/memory"             # SQLite index per agent
touch "$OPENCLAW_DIR/.onboarded"

# Generate a stable token (reused between restarts)
if [ ! -f "$OPENCLAW_DIR/.gateway_token" ]; then
    node -e "require('fs').writeFileSync('$OPENCLAW_DIR/.gateway_token', require('crypto').randomBytes(32).toString('hex'))"
fi
GATEWAY_TOKEN=$(cat "$OPENCLAW_DIR/.gateway_token")

if [ ! -f "$CONFIG_FILE" ]; then
    log "Generating openclaw.json..."
    export CONFIG_FILE GATEWAY_PORT GATEWAY_TOKEN OLLAMA_URL OLLAMA_MODEL PROXY_URL OPENCLAW_GATEWAY_PASSWORD OPENCLAW_DIR
    export EPHEMERAL_MEMORY EPHEMERAL_CPUS EPHEMERAL_TIMEOUT GITHUB_TOKEN

    node << 'NODESCRIPT'
const fs   = require('fs');
const path = require('path');

const port         = parseInt(process.env.GATEWAY_PORT   || '18791');
const ollamaUrl    = 'http://localhost:11435';  // local stream-proxy — smart dispatch
const ollamaModel  = process.env.OLLAMA_MODEL            || 'qwen3.5:27b-q3_k_m';
const gwPassword   = process.env.OPENCLAW_GATEWAY_PASSWORD || '';
const workspaceDir = process.env.OPENCLAW_DIR + '/workspace';
const proxyUrl     = process.env.PROXY_URL               || 'http://host-gateway:3128';
const mem          = process.env.EPHEMERAL_MEMORY        || '512m';
const cpus         = process.env.EPHEMERAL_CPUS          || '0.5';
const timeout      = process.env.EPHEMERAL_TIMEOUT       || '60';
const githubToken  = process.env.GITHUB_TOKEN            || '';
const token        = process.env.GATEWAY_TOKEN;
const role         = process.env.ROLE            || '';

// ── Load specialist prompt if ROLE is set ────────────────────────────────────
function loadSpecialistPrompt(r) {
  const filePath = path.join('/opt/specialists', r + '.md');
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
  return '';
}

const baseContext = `# Research — ALWAYS search before asking

You have access to mcp-docs for documentation search.
The search cascade is: DevDocs (self-hosted) → official APIs → web (SearXNG + scraping).
ALWAYS search for answers yourself before asking the human:
1. Search mcp-docs for relevant documentation
2. If no result, search with different keywords or broader terms
3. Read existing code in the repo for patterns and conventions
4. Check existing tests for expected behavior
5. Only if none of the above resolves your question → ask the human

The human is your LAST resort, not your first.

Execution environment (docker-exec):
- Each execution starts from a clean image — nothing is preserved
- Network: none — no internet access from the ephemeral container
- Limits: ${mem} RAM, ${cpus} CPU, ${timeout}s max
- Available images: python:3.12-slim, node:24-slim, ubuntu:24.04, bash:5

Absolute limits:
- No access to Forgejo, Coolify, or deployment services
- No host file modifications
- Ask for confirmation before any destructive action (file deletion, etc.)

# Work ethic

- It is NORMAL to not know something. Search for answers, and if you cannot find them, say so honestly.
- NEVER hallucinate or invent information. If unsure, say "based on my research, I could not confirm this".
- It is perfectly fine to say: "this is not compatible", "this is not feasible", "this cannot be done legally".
  What matters is being FACTUAL, not optimistic.
- NEVER be lazy. If the task is requested and feasible, do it completely regardless of workload.
- NEVER abandon a task that is possible. Persistence is mandatory.
- If you are truly stuck after research, ask for help — that is normal and expected.
- NEVER loop endlessly on a failing approach. If something fails 3 times, try a different strategy.
  If all strategies fail, escalate to the human with what you tried and why it failed.`;

const specialistPrompt = role ? loadSpecialistPrompt(role) : '';
const systemPrompt = specialistPrompt
  ? specialistPrompt + '\n\n' + baseContext
  : 'You are an interactive development assistant.\n\nYou can:\n- Answer technical questions and search documentation via mcp-docs\n- Write and execute code in isolated ephemeral containers (docker-exec)\n- Manipulate files in your container\n\n' + baseContext;

const config = {
  gateway: {
    mode: 'local',
    bind: '0.0.0.0',
    port,
    auth: {
      mode: 'password',
      ...(gwPassword ? { password: gwPassword } : {}),
    },
    controlUi: {
      enabled: true,
      allowedOrigins: ['*'],
    },
    nodes: { autoApprove: false },
  },
  agents: {
    defaults: {
      provider: 'ollama',
      model: ollamaModel,

      // ── Persistent workspace — mounted on the openclaw_chat_data volume ──
      // All OpenClaw state (MEMORY.md, daily logs, SQLite) survives
      // container restarts thanks to this named volume.
      workspace: workspaceDir,

      // ── Memory flush before compaction ─────────────────────────────────
      // When context approaches the token limit, OpenClaw writes
      // durable info to memory/YYYY-MM-DD.md BEFORE compacting.
      // Ensures nothing important is lost during compression.
      compaction: {
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: 'Session nearing compaction. Store durable memories now.',
          prompt: 'Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.',
        },
      },

      // ── Memory search — hybrid SQLite index (vectors + FTS5) ──────────
      // Allows retrieving context from past sessions via semantic
      // + keyword search. Index is automatically rebuilt
      // if the embedding model changes.
      memorySearch: {
        enabled: true,
        sync: { watch: true },   // auto-reindex if files change
        store: {
          path: `${workspaceDir}/../memory/{agentId}.sqlite`,
        },
      },

      sandbox: {
        mode: 'docker',
        docker: {
          env: {
            HTTP_PROXY:  proxyUrl,
            HTTPS_PROXY: proxyUrl,
            NO_PROXY: 'localhost,127.0.0.1,host-gateway',
          },
        },
      },
    },
    list: [
      {
        id: 'chat',
        name: 'Dev Assistant',
        systemPrompt,
        provider: 'ollama',
        model: ollamaModel,
        tools: {
          allow: ['file.read', 'file.write', 'terminal', 'mcp-docs', 'docker-exec'],
          deny:  ['file.delete', 'git', 'forgejo-mcp', 'browser'],
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
        skills: { enabled: ['docker-exec','cpu-status','loop-detect','spec-init','session-handoff','bmad','user-token','git-provider-chat','semantic-memory','project-context','frontend-design','staged-diff'] },
      },
    ],
  },
  providers: {
    'ollama': { baseUrl: ollamaUrl },
  },
  tools: {
    'mcp-docs': {
      transport: 'stdio',
      command: 'node',
      args: ['/opt/mcp-docs/src/index.js'],
    },
  },
};

fs.mkdirSync(path.dirname(process.env.CONFIG_FILE), { recursive: true, mode: 0o700 });
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log('openclaw.json generated');
NODESCRIPT

else
    log "Persistent session — updating token only"
    node -e "
        const fs  = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        cfg.gateway.token = '$GATEWAY_TOKEN';
        cfg.gateway.nodes = cfg.gateway.nodes || {};
        cfg.gateway.nodes.autoApprove = false;
        fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
    "
fi

# ── 6. Start the stream-proxy ────────────────────────────────────────────
log "Starting stream-proxy (surface=chat, port=11435)..."
SURFACE="chat" \
SCHEDULER_URL="${SCHEDULER_URL:-http://openclaw-agent:7070}"
AGENT_GIT_LOGIN="${AGENT_GIT_LOGIN:-agent}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://openclaw-agent:9001}" \
OLLAMA_GPU_URL="${OLLAMA_BASE_URL:-http://ollama:11434}" \
OLLAMA_CPU_URL="${OLLAMA_CPU_URL:-http://ollama-cpu:11434}" \
PROXY_PORT="11435" \
    node /opt/stream-proxy/stream-proxy.js &
PROXY_PID=$!
log "Stream-proxy PID: $PROXY_PID (surface=chat)"
sleep 1

# ── 6b. Start the dev-manager ────────────────────────────────────────────
# Manages ephemeral Code Server sessions (/dev create|release|status)
# Uses HOST_DOCKER_SOCK=/var/run/host-docker.sock — HOST Docker socket
# mounted under a different name to NOT overwrite the internal rootless DinD
log "Starting dev-manager (port=9002)..."
HOST_DOCKER_SOCK="${HOST_DOCKER_SOCK:-/var/run/host-docker.sock}" \
DEVCONTAINER_IMAGE="${DEVCONTAINER_IMAGE:-ghcr.io/pikatsuto/cdw-devcontainer:latest}" \
DEVCONTAINER_MEMORY="${DEVCONTAINER_MEMORY:-4g}" \
DEVCONTAINER_CPUS="${DEVCONTAINER_CPUS:-2.0}" \
DEV_DOMAIN="${DEV_DOMAIN}" \
DEV_NETWORK="${DEV_NETWORK:-coolify}" \
DEV_IDLE_MS="${DEV_IDLE_MS:-1800000}" \
GIT_PROVIDER_1_URL="${GIT_PROVIDER_1_URL:-http://host-gateway:3000}" \
GIT_PROVIDER_1_TOKEN="${GIT_PROVIDER_1_TOKEN:-${FORGEJO_TOKEN:-}}" \
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}" \
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:27b-q3_k_m}" \
PROJECT_DATA_DIR="${PROJECT_DATA_DIR:-/projects}" \
DEV_MANAGER_PORT="9002" \
    node /opt/scripts/dev-manager.js &
DEV_MGR_PID=$!
log "Dev-manager PID: $DEV_MGR_PID"
sleep 1

# ── 7. Start the OpenClaw gateway ────────────────────────────────────────
log "Starting OpenClaw gateway on :${GATEWAY_PORT}..."
log "Web interface: http://$(hostname -i 2>/dev/null | awk '{print $1}'):${GATEWAY_PORT}"

# FIX 3: HTTPS_PROXY explicitly in the openclaw process environment
exec env \
    HTTP_PROXY="$PROXY_URL" \
    HTTPS_PROXY="$PROXY_URL" \
    NO_PROXY="localhost,127.0.0.1,host-gateway" \
    DOCKER_HOST="$DOCKER_HOST" \
    openclaw gateway start \
        --port "$GATEWAY_PORT" \
        --bind "0.0.0.0" \
        --config "$CONFIG_FILE"
