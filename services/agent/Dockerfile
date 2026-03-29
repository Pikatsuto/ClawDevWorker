###############################################################################
# openclaw-agent  (autonomous development agent)
#
# Base: docker:dind-rootless (Alpine + rootless Docker daemon)
#
# What this container does:
#   1. Starts rootless dockerd
#   2. Exposes an HTTP webhook on :9000 — triggered by Forgejo/GitHub
#   3. On trigger: clones the repo, reads BMAD context if present,
#      codes in ephemeral containers (--rm, --network none), pushes a PR
#   4. Comments on the issue throughout the work
#
# Network access:
#   - Forgejo  : host-gateway:${FORGEJO_HOST_PORT}
#   - Coolify  : host-gateway:${COOLIFY_HOST_PORT}  (previews only)
#   - Internet : via cdw-squid (whitelist: npm, pypi, github, crates.io...)
#   - Ollama   : backend (internal)
#   - MCP docs : mcp-net (internal)
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
COPY services/agent /build/services/agent

# Install dev deps (typescript) + compile
RUN cd /build && npm ci \
 && npx tsc \
 && cp -r /build/dist/shared/opt/* /opt/ \
 && cp -r /build/dist/services/agent/opt/* /opt/

# Copy non-TS assets (SKILL.md, workflows, specialists .md, etc.)
COPY shared /
COPY services/agent /

# Install runtime npm deps
RUN cd /opt/mcp-docs && npm install --omit=dev \
 && cd /opt/gpu-scheduler && npm install --omit=dev 2>/dev/null || true \
 && chmod -R a+rX /opt/

# ── final: clean image ─────────────────────────────────────────────────────
FROM base

ENV OLLAMA_BASE_URL=http://ollama:11434 \
    FORGEJO_HOST_PORT=3000 \
    COOLIFY_HOST_PORT=8000 \
    WEBHOOK_PORT=9000 \
    EPHEMERAL_MEMORY=1g \
    EPHEMERAL_CPUS=1.0 \
    EPHEMERAL_TIMEOUT=300

COPY --from=build /opt /
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/
COPY --chmod=755 services/agent/scripts/entrypoint.sh /usr/local/bin/entrypoint

USER rootless
WORKDIR /home/rootless
ENTRYPOINT ["entrypoint"]
