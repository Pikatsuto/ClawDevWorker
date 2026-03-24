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
        git curl ca-certificates bash \
        python3 py3-pip py3-virtualenv \
        build-base jq

# ── build: install npm packages ────────────────────────────────────────────
FROM base AS build

RUN npm install -g openclaw 2>/dev/null || ( \
        git clone --depth=1 https://github.com/openclaw/openclaw.git /opt/openclaw \
        && cd /opt/openclaw \
        && npm ci --omit=dev \
        && (npm run build 2>/dev/null || true) \
        && npm link \
    )

RUN git config --g lobal user.email "agent@clawforge.local" \
    && git config --global user.name  "ClawForge Agent" \
    && git config --global init.defaultBranch main \
    && git config --global pull.rebase false \
    && git config --global push.autoSetupRemote true

COPY services/worker/scripts/gen-config.js /opt/worker/gen-config.js
COPY services/mcp-docs services/agent/specialists \
    /opt/
COPY services/agent/skills/docker-exec services/worker/skills/git-flow \
    services/worker/skills/agent-fanout services/worker/skills/staged-diff \
    services/worker/skills/codebase-analyze services/worker/skills/session-handoff \
    services/worker/skills/semantic-memory services/worker/skills/project-context \
    services/worker/skills/frontend-design services/worker/skills/spec-init \
    services/worker/skills/loop-detect \
    /opt/skills/

RUN cd /opt/mcp-docs && npm install --omit=dev \
    && chmod -R a+rX /opt/

# ── final: clean image ─────────────────────────────────────────────────────
FROM base

COPY --from=build /opt /
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules/
COPY --from=build /root/.gitconfig /root/.gitconfig
COPY --chmod=755 services/worker/scripts/entrypoint.sh /usr/local/bin/entrypoint

WORKDIR /workspace
ENTRYPOINT ["entrypoint"]