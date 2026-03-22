###############################################################################
# openclaw-chat  (interactive assistant — headless, no Kasm)
#
# Base: kasmweb/ubuntu-noble-dind-rootless (Ubuntu 24.04 + DinD rootless)
#   → Provides pre-configured rootless dockerd, user 1000 (kasm-user)
#   → We do NOT use Kasm VNC/UI — just the rootless DinD
#
# What this container does:
#   1. Starts rootless dockerd (Docker daemon internal to the container)
#   2. Starts the OpenClaw headless gateway on :18791
#   3. On demand, spawns ephemeral containers (--rm) to execute code
#      → network: none (total isolation)  → automatically destroyed after execution
#
# What it does NOT have (vs autonomous agent):
#   - No Kasm VNC/UI
#   - No VSCode
#   - No BMAD
#   - No Forgejo/Coolify access
#   - No FORGEJO_TOKEN required
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

# ── OpenClaw — installed globally ─────────────────────────────────────────────
RUN npm install -g openclaw 2>/dev/null || \
    (git clone --depth=1 https://github.com/openclaw/openclaw.git /opt/openclaw \
     && cd /opt/openclaw \
     && npm ci --omit=dev \
     && (npm run build 2>/dev/null || true) \
     && npm link)

# ── mcp-docs — MCP documentation search server ───────────────────────────────
COPY services/mcp-docs/ /opt/mcp-docs/
RUN cd /opt/mcp-docs && npm install --omit=dev
RUN chmod -R a+rX /opt/mcp-docs

# ── Pre-pulled Docker images for ephemeral containers ─────────────────────────
# Commented out by default — uncomment for the languages you need.
# Pull happens at image build time (once) via rootless DinD.
# Only enable if you have build time available.
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
# ── New v14 skills: BMAD + user-token + git-provider ─────────────────────────
COPY services/chat/skills/bmad/               /opt/skills/bmad/
COPY services/chat/skills/user-token/         /opt/skills/user-token/
COPY services/chat/skills/git-provider/       /opt/skills/git-provider-chat/
# Shared git-provider module (agent, worker and chat)
COPY services/git-provider/                   /opt/git-provider/
# Templates copied into new repos by spec-init
COPY services/devcontainer/defaults/          /opt/devcontainer/defaults/
RUN chmod -R a+rX /opt/skills/ /opt/specialists/ /opt/git-provider/

# ── Startup script ────────────────────────────────────────────────────────────
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

# ── Default environment variables ─────────────────────────────────────────────
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
