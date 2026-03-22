###############################################################################
# openclaw-chat  (assistant interactif — headless, sans Kasm)
#
# Base : kasmweb/ubuntu-noble-dind-rootless (Ubuntu 24.04 + DinD rootless)
#   → Fournit dockerd rootless pré-configuré, user 1000 (kasm-user)
#   → On n'utilise PAS Kasm VNC/UI — juste le DinD rootless
#
# Ce que fait ce container :
#   1. Lance dockerd rootless (daemon Docker interne au container)
#   2. Lance le gateway OpenClaw headless sur :18791
#   3. Sur demande, spawn des containers éphémères (--rm) pour exécuter du code
#      → réseau: none (isolation totale)  → détruit automatiquement après exécution
#
# Ce qu'il n'a PAS (vs agent autonome) :
#   - Pas de Kasm VNC/UI
#   - Pas de VSCode
#   - Pas de BMAD
#   - Pas d'accès Forgejo/Coolify
#   - Pas de FORGEJO_TOKEN requis
###############################################################################

FROM kasmweb/ubuntu-noble-dind-rootless:1.17.0-rolling-daily

USER root

ENV HOME=/home/kasm-default-profile
ENV STARTUPDIR=/dockerstartup
ENV INST_SCRIPTS=$STARTUPDIR/install
WORKDIR $HOME

######### Customize Container Here ###########################################

# ── System dependencies ───────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl wget git ca-certificates gnupg \
        python3 python3-pip python3-venv \
        build-essential \
        jq htop \
        openssh-client \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 LTS ───────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── OpenClaw — installé globalement ──────────────────────────────────────────
RUN npm install -g openclaw 2>/dev/null || \
    (git clone --depth=1 https://github.com/openclaw/openclaw.git /opt/openclaw \
     && cd /opt/openclaw \
     && npm ci --omit=dev \
     && (npm run build 2>/dev/null || true) \
     && npm link)

# ── mcp-docs — MCP server recherche documentation ────────────────────────────
COPY services/mcp-docs/ /opt/mcp-docs/
RUN cd /opt/mcp-docs && npm install --omit=dev
RUN chmod -R a+rX /opt/mcp-docs

# ── Images Docker pré-pullées pour les containers éphémères ──────────────────
# Commenté par défaut — décommenter selon les langages dont tu as besoin.
# Le pull se fait au build de l'image (une seule fois) via le DinD rootless.
# À activer uniquement si tu as du temps de build disponible.
# RUN dockerd-rootless-setuptool.sh install -f 2>/dev/null || true \
#     && (dockerd &) && sleep 5 \
#     && docker pull python:3.12-slim \
#     && docker pull node:22-slim \
#     && docker pull ubuntu:24.04 \
#     && pkill dockerd || true

# ── Skill docker-exec ─────────────────────────────────────────────────────────
COPY services/chat/skills/docker-exec/        /opt/skills/docker-exec/
COPY services/chat/skills/cpu-status/         /opt/skills/cpu-status/
COPY services/worker/skills/session-handoff/  /opt/skills/session-handoff/
COPY services/worker/skills/semantic-memory/  /opt/skills/semantic-memory/
COPY services/worker/skills/project-context/  /opt/skills/project-context/
COPY services/worker/skills/frontend-design/  /opt/skills/frontend-design/
COPY services/worker/skills/staged-diff/      /opt/skills/staged-diff/
COPY services/worker/skills/spec-init/        /opt/skills/spec-init/
COPY services/agent/specialists/              /opt/specialists/
COPY services/worker/skills/loop-detect/      /opt/skills/loop-detect/
# ── Nouveaux skills v14 : BMAD + user-token + git-provider ────────────────────
COPY services/chat/skills/bmad/               /opt/skills/bmad/
COPY services/chat/skills/user-token/         /opt/skills/user-token/
COPY services/chat/skills/git-provider/       /opt/skills/git-provider-chat/
# Module git-provider partagé (agent, worker et chat)
COPY services/git-provider/                   /opt/git-provider/
# Templates copiés dans les nouveaux repos par spec-init
COPY services/devcontainer/defaults/          /opt/devcontainer/defaults/
RUN chmod -R a+rX /opt/skills/ /opt/specialists/ /opt/git-provider/

# ── Script de démarrage ───────────────────────────────────────────────────────
COPY services/chat/scripts/start-chat.sh $STARTUPDIR/start-chat.sh
COPY services/chat/scripts/stream-proxy.js /opt/stream-proxy/stream-proxy.js
RUN mkdir -p /opt/scripts/spec
COPY services/chat/scripts/dev-manager.js     /opt/scripts/dev-manager.js
COPY services/chat/scripts/spec/spec-init.js  /opt/scripts/spec/spec-init.js
RUN chmod +x $STARTUPDIR/start-chat.sh

######### End Customizations #################################################

RUN chown 1000:0 $HOME
RUN $STARTUPDIR/set_user_permission.sh $HOME

ENV HOME=/home/kasm-user
WORKDIR $HOME
RUN mkdir -p $HOME && chown -R 1000:0 $HOME

# ── Variables d'environnement par défaut ──────────────────────────────────────
ENV OPENCLAW_GATEWAY_PORT=18791 \
    OPENCLAW_GATEWAY_BIND=0.0.0.0 \
    OLLAMA_BASE_URL=http://host-gateway:11434 \
    HTTPS_PROXY=http://host-gateway:3128 \
    HTTP_PROXY=http://host-gateway:3128 \
    NO_PROXY=localhost,127.0.0.1,ollama,devdocs,searxng,browserless,mcp-docs \
    EPHEMERAL_MEMORY=512m \
    EPHEMERAL_CPUS=0.5 \
    EPHEMERAL_TIMEOUT=60

USER 1000

CMD ["/dockerstartup/start-chat.sh"]
