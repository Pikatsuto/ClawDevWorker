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

# Copy sources + project root config for tsc
COPY tsconfig.json package.json package-lock.json /build/
COPY shared /build/shared
COPY services/chat /build/services/chat

# Install dev deps (typescript) + compile
RUN cd /build && npm ci \
 && npx tsc \
 && cp -r /build/dist/shared/opt/* /opt/ \
 && cp -r /build/dist/services/chat/opt/* /opt/

# Copy non-TS assets (SKILL.md, defaults, etc.)
COPY shared /
COPY services/chat /

# Install runtime npm deps
RUN cd /opt/mcp-docs && npm install --omit=dev \
    && npm install -g better-sqlite3 \
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
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/
COPY --chmod=755 services/chat/scripts/entrypoint.sh /usr/local/bin/entrypoint

USER rootless
WORKDIR /home/rootless
ENTRYPOINT ["entrypoint"]
