#!/usr/bin/env bash
###############################################################################
# start-agent.sh — Agent de développement autonome (headless, DinD rootless)
#
# Déclenchement : webhook Forgejo (issue assignée au compte agent)
# Flux :
#   1. Forgejo assigne une issue → webhook POST /webhook
#   2. Clone le repo, lit le contexte BMAD si présent dans le repo
#   3. Pose ses questions en commentaire sur l'issue si besoin, s'arrête
#   4. Code dans des containers éphémères isolés (--network none)
#   5. Ouvre une PR "Closes #N"
#   6. Répond aux review comments sur la PR
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
    log "ERREUR : FORGEJO_TOKEN non défini."
    exit 1
fi

# ── 1. Démarrer dockerd rootless ─────────────────────────────────────────────
log "Démarrage de dockerd rootless..."
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p "$XDG_RUNTIME_DIR"

dockerd-rootless.sh --experimental --storage-driver=overlay2 \
    --iptables=false --ip6tables=false \
    > /tmp/dockerd-rootless.log 2>&1 &
DOCKERD_PID=$!

log "Attente du socket Docker..."
for i in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
done
docker info >/dev/null 2>&1 || { log "ERREUR: dockerd rootless n'a pas démarré"; exit 1; }
log "dockerd rootless prêt (PID=$DOCKERD_PID)"

# ── 2. Pre-pull des images éphémères ─────────────────────────────────────────
log "Pre-pull des images éphémères..."
for img in python:3.12-slim node:22-slim ubuntu:24.04 bash:5; do
    docker image inspect "$img" >/dev/null 2>&1 \
        && log "  $img — déjà présente" \
        || { log "  Pull $img..."; docker pull "$img" 2>/dev/null && log "  $img — OK" || log "  $img — échec (ignoré)"; }
done

# ── 3. Whitelist Squid ────────────────────────────────────────────────────────
log "Génération de la whitelist Squid..."
export COOLIFY_PREVIEW_DOMAIN
node << 'NODESCRIPT'
const fs = require('fs');

const lines = [
  '# Whitelist agent — générée au démarrage',
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
  '# Images Docker éphémères',
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
  'index.docker.io',
];

const previewDomain = process.env.COOLIFY_PREVIEW_DOMAIN || '';
if (previewDomain) {
  lines.push('', '# Coolify previews éphémères');
  lines.push('.' + previewDomain);
  lines.push('sslip.io');
}

const dir  = '/etc/squid/whitelist';
const file = dir + '/whitelist.conf';
try {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const domains = lines.filter(l => l && !l.startsWith('#')).length;
  console.log('whitelist.conf écrit (' + domains + ' domaines) → ' + file);
} catch (e) {
  console.error('ERREUR écriture whitelist :', e.message);
  process.exit(1);
}
NODESCRIPT

docker exec agent-squid squid -k reconfigure 2>/dev/null \
    && log "agent-squid rechargé" \
    || log "agent-squid non joignable — sera actif au prochain démarrage"

# ── 4. Skills ─────────────────────────────────────────────────────────────────
mkdir -p "$OPENCLAW_DIR/skills"

for skill in docker-exec cpu-status loop-detect spec-init session-handoff semantic-memory project-context frontend-design staged-diff; do
    if [ -d "/opt/skills/${skill}" ]; then
        log "Installation/mise à jour skill ${skill}..."
        cp -r "/opt/skills/${skill}" "$OPENCLAW_DIR/skills/${skill}"
    fi
done

export SCHEDULER_URL="${SCHEDULER_URL:-http://localhost:7070}"
export PROJECT_DATA_DIR="${PROJECT_DATA_DIR:-/projects}"
export SURFACE="agent"
export PROXY_URL="${PROXY_URL:-http://agent-squid:3128}"

# ── 5. Générer openclaw.json ──────────────────────────────────────────────────
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
    log "Génération de openclaw.json..."
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
  ? `- Previews Coolify : *.${previewDomain}`
  : '- Previews Coolify : non configuré (COOLIFY_PREVIEW_DOMAIN non défini)';

const systemPrompt = `Tu es un agent de développement autonome.

# Fonctionnement

Tu es déclenché par un webhook Forgejo quand une issue t'est assignée.
Tu travailles seul, sans interaction humaine pendant l'exécution.
Tu communiques UNIQUEMENT via les commentaires Forgejo (issue et PR).

# Processus pour chaque issue

1. Lis l'issue en entier ainsi que ses commentaires existants
2. Si le repo contient des fichiers BMAD (docs/bmad/, .bmad/, bmad/ ou similaire),
   lis-les pour comprendre l'architecture, les conventions et le contexte du projet
3. Si tu as des questions bloquantes avant de commencer, commente sur l'issue
   et ARRÊTE-TOI — tu seras redéclenché quand l'humain répondra
4. Crée une branche : agent/issue-{numéro}-{slug-du-titre}
5. Code dans des containers éphémères isolés via docker-exec
6. Commits atomiques avec messages explicites
7. Ouvre une PR avec "Closes #{numéro}" dans la description
8. Si la PR reçoit des review comments, reprends sur la même branche et réponds

# Architecture réseau

Hôtes joignables :
- ollama              → LLM local, seul fournisseur d'inférence
- host-gateway:${fPort}  → Forgejo (lecture issues, push branches, PR, commentaires)
- host-gateway:${cPort}  → Coolify (déclenchement previews uniquement)
- mcp-docs            → documentation technique (devdocs, searxng, browserless)
${previewLine}

Internet via proxy ${proxyUrl} (whitelist stricte, tout est loggué) :
- npm, pypi, crates.io, github.com et CDN associés
- Images Docker éphémères (docker.io)

Containers éphémères : réseau none, ${mem} RAM, ${cpus} CPU, ${timeout}s max

# Limites absolues

- Tu ne merges JAMAIS toi-même une PR
- Tu ne déploies JAMAIS en production directement
- Tu ne modifies JAMAIS la configuration de l'infrastructure
- En cas de doute sur le périmètre, tu commentes sur l'issue et tu attends`;

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
        name: 'Agent Dev',
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
        skills: { enabled: ['docker-exec', 'cpu-status', 'loop-detect', 'session-handoff', 'semantic-memory', 'project-context', 'frontend-design', 'staged-diff'] },
      },
    ],
  },
  providers: {
    'ollama': { baseUrl: ollamaUrl },
  },
};

fs.mkdirSync(path.dirname(process.env.CONFIG_FILE), { recursive: true, mode: 0o700 });
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log('openclaw.json généré');
NODESCRIPT

else
    log "Config existante — token rechargé"
fi

# ── 6. Démarrer le gateway OpenClaw ──────────────────────────────────────────
log "Démarrage gateway OpenClaw webhook sur :${WEBHOOK_PORT}..."
log "→ Configurer dans Forgejo : Settings → Webhooks → http://openclaw-agent:${WEBHOOK_PORT}/webhook"

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

# ── 7. Démarrer le GPU Scheduler ─────────────────────────────────────────────
log "Démarrage GPU Scheduler sur :${SCHEDULER_PORT:-7070}..."
export SCHEDULER_PORT="${SCHEDULER_PORT:-7070}"
export HUMAN_IDLE_MS="${HUMAN_IDLE_MS:-1800000}"
export POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-15000}"
export OPENCLAW_AGENT_URL="http://localhost:${WEBHOOK_PORT}"

node /opt/gpu-scheduler/index.js &
GPU_SCHEDULER_PID=$!
log "GPU Scheduler démarré (PID=${GPU_SCHEDULER_PID})"

# Démarrer l'orchestrateur
ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-9001}"
MEMORY_DIR="${OPENCLAW_DIR}/workspace/memory"
WORKER_IMAGE="${WORKER_IMAGE:-ghcr.io/pikatsuto/cdw-worker:latest}"

node /opt/orchestrator/index.js &
ORCHESTRATOR_PID=$!
log "Orchestrateur démarré (PID=${ORCHESTRATOR_PID})"
