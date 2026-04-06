###############################################################################
# openclaw-worker  (autonomous dev/qa agent)
#
# Base: node:24-alpine
#
# What this container does:
#   Ephemeral worker that clones a repo, runs an OpenClaw specialist gate,
#   commits results, and exits.
###############################################################################

# ── base: runtime dependencies ─────────────────────────────────────────────
FROM node:24-alpine AS base
RUN apk add --no-cache \
        git curl ca-certificates bash jq \
 && npm install -g openclaw 2>/dev/null || ( \
        git clone --depth=1 https://github.com/openclaw/openclaw.git /opt/openclaw \
        && cd /opt/openclaw \
        && npm ci --omit=dev \
        && (npm run build 2>/dev/null || true) \
        && npm link \
    )

# ── build: compile TS + assets ─────────────────────────────────────────────
FROM base AS build

RUN apk add --no-cache build-base

# Copy sources + project root config for tsc
COPY tsconfig.json package.json package-lock.json /build/
COPY shared /build/shared
COPY services/worker /build/services/worker

# Install dev deps (typescript) + compile
RUN cd /build && npm ci \
 && npx tsc \
 && cp -r /build/dist/shared/opt/* /opt/ \
 && cp -r /build/dist/services/worker/opt/* /opt/

# Copy non-TS assets (SKILL.md, etc.)
COPY shared /
COPY services/worker /

# Install runtime npm deps
RUN cd /opt/mcp-docs && npm install --omit=dev \
    && chmod -R a+rX /opt/

# ── final: clean image ─────────────────────────────────────────────────────
FROM base

COPY --from=build /opt/ /opt/
COPY --chmod=755 services/worker/scripts/entrypoint.sh /usr/local/bin/entrypoint

WORKDIR /workspace
ENTRYPOINT ["entrypoint"]