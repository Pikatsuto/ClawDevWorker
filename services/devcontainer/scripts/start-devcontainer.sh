#!/usr/bin/env bash
###############################################################################
# start-devcontainer.sh — Ephemeral dev container entrypoint
#
# On startup:
#   1. Init user volume (VSCode settings + extensions on first run)
#   2. Clone repo into /workspace if specified
#   3. Read .devcontainer/devcontainer.json → postCreateCommand
#   4. Generate openclaw.json via coollabsio's configure.js
#   5. Start OpenClaw gateway (port 8080 via nginx)
#   6. Start Code Server (port 8888)
###############################################################################

set -euo pipefail

log() { echo "[devcontainer] $(date '+%H:%M:%S') $*"; }
fail() { echo "[devcontainer] ❌ $*" >&2; exit 1; }

# ── Environment variables ──────────────────────────────────────────────────
REPO="${REPO:-}"                            # owner/repo to clone
GIT_PROVIDER_1_URL="${GIT_PROVIDER_1_URL:-http://host-gateway:3000}"
GIT_PROVIDER_1_TOKEN="${GIT_PROVIDER_1_TOKEN:-${FORGEJO_TOKEN:-}}"
USER_ID="${USER_ID:-default}"              # user identifier for volumes
PROJECT_DATA_DIR="${PROJECT_DATA_DIR:-/projects}"
SCHEDULER_URL="${SCHEDULER_URL:-http://openclaw-agent:7070}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:27b-q3_k_m}"
SURFACE="vscode"
STAGED_MODE="${STAGED_MODE:-true}"
CODE_SERVER_PASSWORD="${CODE_SERVER_PASSWORD:-}"
WORKSPACE_DIR="/workspace"

# ── 1. Init user volume (first startup only) ──────────────────────────────
VSCODE_USER_DIR="$HOME/.config/Code/User"
VSCODE_FIRST_RUN_FLAG="$HOME/.config/.devcontainer_initialized"

if [ ! -f "$VSCODE_FIRST_RUN_FLAG" ]; then
    log "First startup — initializing VSCode profile..."

    mkdir -p "$VSCODE_USER_DIR"

    # Copy settings.json if missing or different
    if [ ! -f "$VSCODE_USER_DIR/settings.json" ]; then
        cp /opt/devcontainer/config/vscode/settings.json "$VSCODE_USER_DIR/settings.json"
        log "settings.json installed"
    fi

    # Install extensions from extensions.txt
    if [ -f "/opt/devcontainer/config/vscode/extensions.txt" ]; then
        log "Installing VSCode extensions..."
        while IFS= read -r ext; do
            # Skip comments and empty lines
            [[ -z "$ext" || "$ext" == \#* ]] && continue
            code-server --install-extension "$ext" --force 2>/dev/null \
                && log "  ✓ $ext" \
                || log "  ⚠ $ext (non-blocking)"
        done < "/opt/devcontainer/config/vscode/extensions.txt"
    fi

    touch "$VSCODE_FIRST_RUN_FLAG"
    log "VSCode profile initialized"
fi

# ── 2. Install OpenClaw skills ────────────────────────────────────────────
SKILLS_DIR="$HOME/.openclaw/workspace/skills"
mkdir -p "$SKILLS_DIR"

for skill in gpu-dispatch cpu-status loop-detect staged-diff codebase-analyze \
             session-handoff semantic-memory project-context frontend-design \
             spec-init bmad user-token git-provider-chat; do
    [ -d "/opt/skills/${skill}" ] && \
        cp -r "/opt/skills/${skill}" "$SKILLS_DIR/${skill}" 2>/dev/null || true
done
log "OpenClaw skills installed"

# ── 3. Clone repo if specified ────────────────────────────────────────────
if [ -n "$REPO" ]; then
    REPO_NAME="${REPO##*/}"
    REPO_DIR="$WORKSPACE_DIR/$REPO_NAME"

    if [ ! -d "$REPO_DIR/.git" ]; then
        log "Cloning $REPO..."
        CLONE_URL="${GIT_PROVIDER_1_URL}/${REPO}.git"
        # Inject token into URL for auth
        CLONE_URL_AUTH="${CLONE_URL//:\/\//:\/\/coder:${GIT_PROVIDER_1_TOKEN}@}"
        git clone --depth=50 "$CLONE_URL_AUTH" "$REPO_DIR" 2>/dev/null \
            || git clone "$CLONE_URL_AUTH" "$REPO_DIR" \
            || log "⚠ Clone failed — empty workspace"
    else
        log "Repo already present — git pull..."
        git -C "$REPO_DIR" pull --quiet 2>/dev/null || true
    fi

    # Run incremental codebase index
    if [ -d "$REPO_DIR" ]; then
        export WORKSPACE="$REPO_DIR"
        export PROJECT_NAME="${REPO//\//_}"
        node /opt/skills/codebase-analyze/incremental-index.js 2>/dev/null || true
        log "Codebase index updated"
    fi
fi

# ── 4. Read and execute devcontainer.json ─────────────────────────────────
DEVCONTAINER_JSON=""
for repo_dir in "$WORKSPACE_DIR"/*/; do
    candidate="$repo_dir/.devcontainer/devcontainer.json"
    if [ -f "$candidate" ]; then
        DEVCONTAINER_JSON="$candidate"
        break
    fi
done

if [ -n "$DEVCONTAINER_JSON" ]; then
    log "devcontainer.json found: $DEVCONTAINER_JSON"

    # postCreateCommand — executed if the flag doesn't exist yet
    POST_CREATE_FLAG="$WORKSPACE_DIR/.devcontainer/.post_create_done_$(md5sum "$DEVCONTAINER_JSON" 2>/dev/null | cut -c1-8 || echo 'x')"

    if [ ! -f "$POST_CREATE_FLAG" ]; then
        POST_CMD=$(node -e "
            const d = JSON.parse(require('fs').readFileSync('$DEVCONTAINER_JSON', 'utf8'));
            const cmd = d.postCreateCommand || d.postAttachCommand || '';
            process.stdout.write(typeof cmd === 'string' ? cmd : cmd.join(' && '));
        " 2>/dev/null || echo "")

        if [ -n "$POST_CMD" ]; then
            log "Running postCreateCommand: $POST_CMD"
            REPO_DIR_CMD=$(dirname "$(dirname "$DEVCONTAINER_JSON")")
            (cd "$REPO_DIR_CMD" && bash -c "$POST_CMD") \
                && log "postCreateCommand completed" \
                || log "⚠ postCreateCommand failed (non-blocking)"
        fi

        touch "$POST_CREATE_FLAG"
    else
        log "postCreateCommand already executed for this devcontainer.json version"
    fi
fi

# ── 5. Generate openclaw.json via coollabsio's configure.js ──────────────
OPENCLAW_DIR="$HOME/.openclaw"
OPENCLAW_CONFIG="$OPENCLAW_DIR/openclaw.json"
mkdir -p "$OPENCLAW_DIR"

# Generate a stable gateway token (persistent in user volume)
GATEWAY_TOKEN_FILE="$OPENCLAW_DIR/.gateway_token"
if [ ! -f "$GATEWAY_TOKEN_FILE" ]; then
    node -e "require('fs').writeFileSync('$GATEWAY_TOKEN_FILE', \
        require('crypto').randomBytes(32).toString('hex'))"
fi
GATEWAY_TOKEN=$(cat "$GATEWAY_TOKEN_FILE")

# Generate openclaw.json
node << NODESCRIPT
const fs   = require('fs');
const path = require('path');

const config = {
  gateway: {
    mode:  'local',
    bind:  'localhost',
    port:  18789,
    token: '${GATEWAY_TOKEN}',
    nodes: { autoApprove: true },
  },
  agents: {
    defaults: {
      provider:  'ollama',
      model:     '${OLLAMA_MODEL}',
      workspace: '${WORKSPACE_DIR}',
      compaction: {
        memoryFlush: {
          enabled:             true,
          softThresholdTokens: 4000,
          systemPrompt:       'Session nearing compaction. Store durable memories now.',
          prompt:             'Write lasting notes; reply NO_REPLY if nothing to store.',
        },
      },
      memorySearch: {
        enabled: true,
        sync:    { watch: true },
        store:   { path: '${OPENCLAW_DIR}/memory/{agentId}.sqlite' },
      },
    },
    list: [
      {
        id:      'dev',
        name:    'Dev Assistant',
        provider:'ollama',
        model:   '${OLLAMA_MODEL}',
        tools: {
          confirm: {
            'file.write':  true,
            'file.delete': true,
            'terminal':    true,
            'git':         true,
          },
          deny: ['browser'],
        },
        skills: {
          enabled: [
            'gpu-dispatch', 'cpu-status', 'loop-detect', 'staged-diff',
            'codebase-analyze', 'session-handoff', 'semantic-memory',
            'project-context', 'frontend-design',
            'spec-init', 'bmad', 'user-token', 'git-provider-chat',
          ],
        },
        env: {
          SURFACE:          'vscode',
          STAGED_MODE:      'true',
          PROJECT_DATA_DIR: '${PROJECT_DATA_DIR}',
          SCHEDULER_URL:    '${SCHEDULER_URL}',
          GIT_PROVIDER_1_URL:   '${GIT_PROVIDER_1_URL}',
          GIT_PROVIDER_1_TOKEN: '${GIT_PROVIDER_1_TOKEN}',
          AGENT_GIT_LOGIN:      '${AGENT_GIT_LOGIN}',
          ORCHESTRATOR_URL:     'http://openclaw-agent:9001',
          MODEL_COMPLEX:    '${OLLAMA_MODEL}',
          MODEL_STANDARD:   '${MODEL_STANDARD}',
          MODEL_LIGHT:      '${MODEL_LIGHT}',
          MODEL_TRIVIAL:    '${MODEL_TRIVIAL}',
          MODEL_CPU:        '${MODEL_CPU}',
        },
        mcpServers: {
          'mcp-docs': {
            transport: 'stdio',
            command:   'node',
            args:      ['/opt/mcp-docs/src/index.js'],
            env: {
              DEVDOCS_URL:   'http://devdocs:9292',
              SEARXNG_URL:   'http://searxng:8080',
              NODRIVER_URL:  'http://browserless:3000',
              MAX_RESULTS:   '5',
              FETCH_TIMEOUT: '8000',
            },
          },
        },
      },
    ],
  },
  providers: {
    ollama: { baseUrl: '${OLLAMA_BASE_URL}' },
  },
};

fs.mkdirSync('${OPENCLAW_DIR}', { recursive: true, mode: 0o700 });
fs.writeFileSync('${OPENCLAW_CONFIG}', JSON.stringify(config, null, 2), { mode: 0o600 });
console.log('openclaw.json generated');
NODESCRIPT

log "openclaw.json generated"

# ── 6. Start OpenClaw gateway ─────────────────────────────────────────────
log "Starting OpenClaw gateway (port 18789)..."
openclaw gateway \
    --config "$OPENCLAW_CONFIG" \
    --bind localhost \
    --port 18789 &
OPENCLAW_PID=$!

# Wait for gateway to be ready
for i in $(seq 1 20); do
    curl -sf "http://localhost:18789/healthz" >/dev/null 2>&1 && break
    sleep 1
done
log "OpenClaw gateway started (PID $OPENCLAW_PID)"

# ── 7. Start Code Server ─────────────────────────────────────────────────
log "Starting Code Server (port 8888)..."

CODE_SERVER_ARGS=(
    "--bind-addr" "0.0.0.0:8888"
    "--user-data-dir" "$HOME/.local/share/code-server"
    "--extensions-dir" "$HOME/.local/share/code-server/extensions"
    "--disable-telemetry"
    "--disable-update-check"
)

# Authentication
if [ -n "$CODE_SERVER_PASSWORD" ]; then
    export PASSWORD="$CODE_SERVER_PASSWORD"
    CODE_SERVER_ARGS+=("--auth" "password")
else
    CODE_SERVER_ARGS+=("--auth" "none")
fi

# Open workspace directly if repo was cloned
if [ -n "$REPO" ]; then
    REPO_NAME="${REPO##*/}"
    CODE_SERVER_ARGS+=("$WORKSPACE_DIR/$REPO_NAME")
fi

log "Code Server ready on :8888"

# Graceful shutdown handler
cleanup() {
    log "Shutting down — committing pending changes..."
    # Attempt auto-commit if uncommitted changes exist
    for repo_dir in "$WORKSPACE_DIR"/*/; do
        [ -d "$repo_dir/.git" ] || continue
        if git -C "$repo_dir" status --porcelain | grep -q .; then
            git -C "$repo_dir" add -A
            git -C "$repo_dir" commit -m "chore: auto-save dev session $(date '+%Y-%m-%d %H:%M')" \
                2>/dev/null || true
            git -C "$repo_dir" push 2>/dev/null || true
            log "  ✓ $(basename $repo_dir) saved"
        fi
    done
    kill $OPENCLAW_PID 2>/dev/null || true
    log "Container stopped gracefully"
}
trap cleanup SIGTERM SIGINT

exec code-server "${CODE_SERVER_ARGS[@]}"
