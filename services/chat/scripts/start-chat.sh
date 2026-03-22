#!/usr/bin/env bash
###############################################################################
# start-chat.sh — Assistant OpenClaw interactif (headless, DinD rootless)
#
# Corrections v2 :
#   1. Whitelist Squid générée dynamiquement depuis les env vars (comme agent)
#   2. deleteConfirmation supprimé (clé inexistante) → sécurité via tools.allow
#   3. HTTPS_PROXY passé explicitement à OpenClaw via env au lancement
###############################################################################

set -euo pipefail

OPENCLAW_DIR="$HOME/.openclaw"
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18791}"
OLLAMA_URL="http://localhost:11435"  # stream-proxy local — dispatch via scheduler
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:27b-q3_k_m}"
OPENCLAW_GATEWAY_PASSWORD="${OPENCLAW_GATEWAY_PASSWORD:-}"
PROXY_URL="http://host-gateway:3128"
EPHEMERAL_MEMORY="${EPHEMERAL_MEMORY:-512m}"
EPHEMERAL_CPUS="${EPHEMERAL_CPUS:-0.5}"
EPHEMERAL_TIMEOUT="${EPHEMERAL_TIMEOUT:-60}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

log() { echo "[chat] $(date '+%H:%M:%S') $*"; }

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

# ── 3. Whitelist Squid — générée dynamiquement depuis les env vars ────────────
# Volume partagé squid_chat_whitelist monté dans :
#   openclaw-chat → /etc/squid/whitelist  (écriture)
#   chat-squid    → /etc/squid/whitelist  (lecture via squid-chat.conf)
log "Génération de la whitelist Squid..."
node << 'NODESCRIPT'
const fs = require('fs');

const lines = [
  '# Whitelist chat — générée au démarrage par start-chat.sh',
  '# Ne pas éditer manuellement.',
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

// Chemin du volume partagé avec chat-squid
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

# Signal à chat-squid de recharger sa config
docker exec chat-squid squid -k reconfigure 2>/dev/null \
    && log "chat-squid rechargé avec la nouvelle whitelist" \
    || log "chat-squid non joignable via docker exec — sera actif au prochain démarrage"

# ── 4. Installer les skills ────────────────────────────────────────────────────
mkdir -p "$OPENCLAW_DIR/skills"

SKILL_DIR="$OPENCLAW_DIR/skills/docker-exec"
if [ ! -d "$SKILL_DIR" ]; then
    log "Installation du skill docker-exec..."
    cp -r /opt/skills/docker-exec "$SKILL_DIR"
    log "Skill docker-exec installé"
fi

# Skills mis à jour à chaque démarrage
for skill in cpu-status loop-detect spec-init session-handoff semantic-memory project-context frontend-design staged-diff; do
    if [ -d "/opt/skills/${skill}" ]; then
        log "Installation/mise à jour skill ${skill}..."
        cp -r "/opt/skills/${skill}" "$OPENCLAW_DIR/skills/${skill}"
    fi
done

# Variables d'env pour les skills
export SCHEDULER_URL="${SCHEDULER_URL:-http://openclaw-agent:7070}"
AGENT_GIT_LOGIN="${AGENT_GIT_LOGIN:-agent}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://openclaw-agent:9001}"
export PROXY_URL="${PROXY_URL:-http://localhost:11435}"
export PROJECT_DATA_DIR="${PROJECT_DATA_DIR:-/projects}"
export SURFACE="chat"
export STAGED_MODE="${STAGED_MODE:-true}"

# ── 5. Générer openclaw.json ─────────────────────────────────────────────────
mkdir -p "$OPENCLAW_DIR"
chmod 700 "$OPENCLAW_DIR"
# Créer les dossiers persistants dès le démarrage
# → survie garantie entre redémarrages via le volume openclaw_chat_data
mkdir -p "$OPENCLAW_DIR/workspace/memory"   # logs quotidiens YYYY-MM-DD.md
mkdir -p "$OPENCLAW_DIR/memory"             # index SQLite par agent
touch "$OPENCLAW_DIR/.onboarded"

# Générer un token stable (re-utilisé entre redémarrages)
if [ ! -f "$OPENCLAW_DIR/.gateway_token" ]; then
    node -e "require('fs').writeFileSync('$OPENCLAW_DIR/.gateway_token', require('crypto').randomBytes(32).toString('hex'))"
fi
GATEWAY_TOKEN=$(cat "$OPENCLAW_DIR/.gateway_token")

if [ ! -f "$CONFIG_FILE" ]; then
    log "Génération de openclaw.json..."
    export CONFIG_FILE GATEWAY_PORT GATEWAY_TOKEN OLLAMA_URL OLLAMA_MODEL PROXY_URL OPENCLAW_GATEWAY_PASSWORD OPENCLAW_DIR
    export EPHEMERAL_MEMORY EPHEMERAL_CPUS EPHEMERAL_TIMEOUT GITHUB_TOKEN

    node << 'NODESCRIPT'
const fs   = require('fs');
const path = require('path');

const port         = parseInt(process.env.GATEWAY_PORT   || '18791');
const ollamaUrl    = 'http://localhost:11435';  // stream-proxy local — dispatch intelligent
const ollamaModel  = process.env.OLLAMA_MODEL            || 'qwen3.5:27b-q3_k_m';
const gwPassword   = process.env.OPENCLAW_GATEWAY_PASSWORD || '';
const workspaceDir = process.env.OPENCLAW_DIR + '/workspace';
const proxyUrl     = process.env.PROXY_URL               || 'http://host-gateway:3128';
const mem          = process.env.EPHEMERAL_MEMORY        || '512m';
const cpus         = process.env.EPHEMERAL_CPUS          || '0.5';
const timeout      = process.env.EPHEMERAL_TIMEOUT       || '60';
const githubToken  = process.env.GITHUB_TOKEN            || '';
const token        = process.env.GATEWAY_TOKEN;

const systemPrompt = `Tu es un assistant de développement interactif.

Tu peux :
- Répondre à des questions techniques et chercher de la doc via mcp-docs
- Écrire et exécuter du code dans des containers éphémères isolés (docker-exec)
- Manipuler des fichiers dans ton container

Environnement d'exécution (docker-exec) :
- Chaque exécution part d'une image propre — rien n'est conservé
- Réseau : none — aucun accès internet depuis le container éphémère
- Limites : ${mem} RAM, ${cpus} CPU, ${timeout}s max
- Images disponibles : python:3.12-slim, node:22-slim, ubuntu:24.04, bash:5

Limites absolues :
- Pas d'accès à Forgejo, Coolify, ni aux services de déploiement
- Pas de modification des fichiers host
- Demande confirmation avant toute action destructive (suppression de fichiers, etc.)`;

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

      // ── Workspace persistant — monté sur le volume openclaw_chat_data ──────
      // Tout l'état OpenClaw (MEMORY.md, logs quotidiens, SQLite) survit
      // aux redémarrages du container grâce à ce volume nommé.
      workspace: workspaceDir,

      // ── Memory flush avant compaction ────────────────────────────────────
      // Quand le contexte approche la limite de tokens, OpenClaw écrit
      // les infos durables dans memory/YYYY-MM-DD.md AVANT de compacter.
      // Garantit que rien d'important n'est perdu lors de la compression.
      compaction: {
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: 'Session nearing compaction. Store durable memories now.',
          prompt: 'Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.',
        },
      },

      // ── Memory search — index SQLite hybride (vecteurs + FTS5) ──────────
      // Permet de retrouver le contexte de sessions passées par recherche
      // sémantique + mots-clés. L'index est reconstruit automatiquement
      // si le modèle d'embedding change.
      memorySearch: {
        enabled: true,
        sync: { watch: true },   // re-indexe automatiquement si les fichiers changent
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
        name: 'Assistant Dev',
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
console.log('openclaw.json généré');
NODESCRIPT

else
    log "Session persistante — mise à jour du token uniquement"
    node -e "
        const fs  = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        cfg.gateway.token = '$GATEWAY_TOKEN';
        cfg.gateway.nodes = cfg.gateway.nodes || {};
        cfg.gateway.nodes.autoApprove = false;
        fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
    "
fi

# ── 6. Démarrer le stream-proxy ──────────────────────────────────────────────
log "Démarrage du stream-proxy (surface=chat, port=11435)..."
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

# ── 6b. Démarrer le dev-manager ───────────────────────────────────────────────
# Gère les sessions Code Server éphémères (/dev create|release|status)
# Utilise HOST_DOCKER_SOCK=/var/run/host-docker.sock — socket Docker du HOST
# monté sous un nom différent pour ne PAS écraser le DinD rootless interne
log "Démarrage du dev-manager (port=9002)..."
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

# ── 7. Démarrer le gateway OpenClaw ─────────────────────────────────────────
log "Démarrage du gateway OpenClaw sur :${GATEWAY_PORT}..."
log "Interface web : http://$(hostname -i 2>/dev/null | awk '{print $1}'):${GATEWAY_PORT}"

# CORRECTION 3 : HTTPS_PROXY explicitement dans l'environnement du process openclaw
exec env \
    HTTP_PROXY="$PROXY_URL" \
    HTTPS_PROXY="$PROXY_URL" \
    NO_PROXY="localhost,127.0.0.1,host-gateway" \
    DOCKER_HOST="$DOCKER_HOST" \
    openclaw gateway start \
        --port "$GATEWAY_PORT" \
        --bind "0.0.0.0" \
        --config "$CONFIG_FILE"
