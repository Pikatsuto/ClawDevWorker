###############################################################################
# openclaw-chat  (interactive assistant)
#
# Base: docker:dind-rootless (Alpine + rootless Docker daemon)
#
# What this container does:
#   1. Starts rootless dockerd (Docker daemon internal to the container)
#   2. Starts the OpenClaw headless gateway on :18791
#   3. On demand, spawns ephemeral containers (--rm) to execute code
#      → network: none (total isolation)  → automatically destroyed after execution
###############################################################################

# ── base: runtime dependencies ─────────────────────────────────────────────
FROM docker:dind-rootless AS base
USER root
RUN apk add --no-cache \
        curl wget git ca-certificates gnupg bash \
        python3 py3-pip py3-virtualenv \
        build-base jq htop openssh-client \
        nodejs npm

# ── build: install npm packages ────────────────────────────────────────────
FROM base AS build

RUN npm install -g openclaw 2>/dev/null || ( \
        git clone --depth=1 https://github.com/openclaw/openclaw.git /opt/openclaw \
        && cd /opt/openclaw \
        && npm ci --omit=dev \
        && (npm run build 2>/dev/null || true) \
        && npm link \
    )

RUN mkdir -p /opt/scripts/spec
COPY services/mcp-docs services/git-provider \
    services/agent/specialists \
    /opt/
COPY services/devcontainer/defaults /opt/devcontainer/defaults/ /opt/specialists/
COPY services/chat/skills/docker-exec services/chat/skills/cpu-status \
    services/chat/skills/bmad services/chat/skills/user-token \
    services/chat/skills/git-provider \
    services/worker/skills/session-handoff services/worker/skills/semantic-memory \
    services/worker/skills/project-context services/worker/skills/frontend-design \
    services/worker/skills/staged-diff services/worker/skills/spec-init \
    services/worker/skills/loop-detect \
    /opt/skills/
COPY services/chat/scripts/dev-manager.js services/chat/scripts/spec \
    /opt/scripts/
COPY services/chat/scripts/stream-proxy.js /opt/stream-proxy/stream-proxy.js

RUN cd /opt/mcp-docs && npm install --omit=dev \
    && chmod -R a+rX /opt/

# ── final: clean image ─────────────────────────────────────────────────────
FROM base

ENV OPENCLAW_GATEWAY_PORT=18791 \
    OPENCLAW_GATEWAY_BIND=0.0.0.0 \
    OLLAMA_BASE_URL=http://host-gateway:11434 \
    HTTPS_PROXY=http://host-gateway:3128 \
    HTTP_PROXY=http://host-gateway:3128 \
    NO_PROXY=localhost,127.0.0.1,ollama,devdocs,searxng,browserless,mcp-docs \
    EPHEMERAL_MEMORY=512m \
    EPHEMERAL_CPUS=0.5 \
    EPHEMERAL_TIMEOUT=60

COPY --from=build /opt /
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules/
COPY --chmod=755 services/chat/scripts/entrypoint.sh /usr/local/bin/entrypoint

USER rootless
WORKDIR /home/rootless
ENTRYPOINT ["entrypoint"]