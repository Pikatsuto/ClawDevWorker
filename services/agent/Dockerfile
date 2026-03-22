###############################################################################
# openclaw-agent  (autonomous development agent — headless, no Kasm)
#
# Base: kasmweb/ubuntu-noble-dind-rootless (Ubuntu 24.04 + DinD rootless)
#   → Provides pre-configured rootless dockerd, user 1000 (kasm-user)
#   → We do NOT use Kasm VNC/UI — just the rootless DinD
#
# What this container does:
#   1. Starts rootless dockerd
#   2. Exposes an HTTP webhook on :9000 — triggered by Forgejo (assigned issue)
#   3. On trigger: clones the repo, reads BMAD context if present,
#      codes in ephemeral containers (--rm, --network none), pushes a PR
#   4. Comments on the Forgejo issue throughout the work
#
# Network access:
#   - Forgejo  : host-gateway:${FORGEJO_HOST_PORT}
#   - Coolify  : host-gateway:${COOLIFY_HOST_PORT}  (previews only)
#   - Internet : via agent-squid (whitelist: npm, pypi, github, crates.io...)
#   - Ollama   : backend (internal)
#   - MCP docs : mcp-net (internal)
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
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
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
COPY services/agent/gpu-scheduler/ /opt/gpu-scheduler/
RUN cd /opt/gpu-scheduler && npm install --omit=dev 2>/dev/null || true
COPY services/agent/orchestrator/ /opt/orchestrator/
COPY services/git-provider/ /opt/git-provider/
COPY services/agent/openclaw.plugin.json /opt/openclaw.plugin.json
RUN chmod -R a+rX /opt/mcp-docs /opt/gpu-scheduler /opt/orchestrator /opt/git-provider

# ── Skill docker-exec ─────────────────────────────────────────────────────────
COPY services/agent/skills/docker-exec/       /opt/skills/docker-exec/
COPY services/chat/skills/cpu-status/         /opt/skills/cpu-status/
COPY services/worker/skills/session-handoff/  /opt/skills/session-handoff/
COPY services/worker/skills/semantic-memory/  /opt/skills/semantic-memory/
COPY services/worker/skills/project-context/  /opt/skills/project-context/
COPY services/worker/skills/frontend-design/  /opt/skills/frontend-design/
COPY services/worker/skills/staged-diff/      /opt/skills/staged-diff/
COPY services/worker/skills/spec-init/     /opt/skills/spec-init/
COPY services/agent/specialists/              /opt/specialists/
COPY services/worker/skills/loop-detect/ /opt/skills/loop-detect/
RUN chmod -R a+rX /opt/skills/ /opt/specialists/

# ── Startup script ────────────────────────────────────────────────────────────
COPY services/agent/scripts/start-agent.sh $STARTUPDIR/start-agent.sh
RUN chmod +x $STARTUPDIR/start-agent.sh

######### End Customizations #################################################

RUN chown 1000:0 $HOME
RUN $STARTUPDIR/set_user_permission.sh $HOME

ENV HOME=/home/kasm-user
WORKDIR $HOME
RUN mkdir -p $HOME && chown -R 1000:0 $HOME

ENV OLLAMA_BASE_URL=http://ollama:11434 \
    FORGEJO_HOST_PORT=3000 \
    COOLIFY_HOST_PORT=8000 \
    WEBHOOK_PORT=9000 \
    EPHEMERAL_MEMORY=1g \
    EPHEMERAL_CPUS=1.0 \
    EPHEMERAL_TIMEOUT=300

USER 1000

CMD ["/dockerstartup/start-agent.sh"]
