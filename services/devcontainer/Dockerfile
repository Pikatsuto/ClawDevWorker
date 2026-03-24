###############################################################################
# devcontainer — Base image for ephemeral dev sessions
#
# Base: alpine:3.21
#
# Contains:
#   - Code Server (VSCode in the browser)
#   - OpenClaw gateway (from coollabsio/openclaw, configure.js included)
#   - Dev stacks: Node 22 + Python 3 + Rust + Go + Git
#   - Skills + VSCode config
#
# Usage: ephemeral container dynamically spawned by the orchestrator
#   - Per-user volume: ~/.config/Code/User + extensions + ~/.openclaw
#   - Repo cloned into /workspace at startup
#   - Repo's devcontainer.json → postCreateCommand executed if present
#   - Destroyed on /dev release (--rm)
###############################################################################

# ── Stage 1: OpenClaw from coollabsio ──────────────────────────────────────
FROM coollabsio/openclaw:latest AS openclaw-base

# ── Stage 2: base ──────────────────────────────────────────────────────────
FROM alpine:3.21 AS base

ENV HOME=/home/coder \
    USER=coder \
    SHELL=/bin/bash \
    PATH=/home/coder/.cargo/bin:/usr/local/go/bin:/home/coder/.local/bin:$PATH

RUN addgroup -g 1000 coder \
 && adduser -u 1000 -G coder -s /bin/bash -D coder

RUN apk add --no-cache \
        curl wget git ca-certificates gnupg bash \
        build-base pkgconf openssl-dev \
        python3 py3-pip py3-virtualenv python3-dev \
        jq htop tree ripgrep fzf \
        openssh-client \
        unzip zip \
        nginx \
        nodejs npm \
        go rust cargo

RUN npm install -g yarn pnpm typescript ts-node

# ── Stage 3: build ─────────────────────────────────────────────────────────
FROM base AS build

# OpenClaw from coollabsio
COPY --from=openclaw-base /opt/openclaw /opt/openclaw
COPY --from=openclaw-base /usr/local/bin/openclaw /usr/local/bin/openclaw
COPY --from=openclaw-base /app/scripts /opt/openclaw-scripts/

# mcp-docs
COPY services/mcp-docs services/git-provider \
     services/agent/specialists \
     /opt/
RUN cd /opt/mcp-docs && npm install --omit=dev

# Skills (merged COPYs)
COPY services/worker/skills/staged-diff services/worker/skills/codebase-analyze \
    services/worker/skills/session-handoff services/worker/skills/semantic-memory \
    services/worker/skills/project-context services/worker/skills/frontend-design \
    services/worker/skills/loop-detect services/worker/skills/spec-init \
    services/devcontainer/skills/gpu-dispatch services/devcontainer/skills/cpu-status \
    services/devcontainer/skills/bmad services/devcontainer/skills/user-token \
    services/devcontainer/skills/git-provider-chat \
    /opt/skills/

RUN mkdir -p /opt/scripts/spec
COPY services/chat/scripts/spec/spec-init.js /opt/scripts/spec/spec-init.js

# VSCode config
COPY services/devcontainer/config/vscode/settings.json \
     services/devcontainer/config/vscode/extensions.txt \
     /opt/devcontainer/config/vscode/

RUN chmod -R a+rX /opt/

# ── Stage 4: Code Server install ───────────────────────────────────────────
FROM base AS codeserver
RUN CS_VERSION=$(curl -fsSL "https://api.github.com/repos/coder/code-server/releases/latest" | jq -r .tag_name | sed 's/^v//') \
     && curl -fsSL "https://github.com/coder/code-server/releases/download/v${CS_VERSION}/code-server-${CS_VERSION}-linux-amd64.tar.gz" \
          -o /tmp/code-server.tar.gz \
     && mkdir -p /opt/code-server \
     && tar -xzf /tmp/code-server.tar.gz -C /opt/code-server --strip-components=1 \
     && rm /tmp/code-server.tar.gz

# ── final: clean image ─────────────────────────────────────────────────────
FROM base

COPY --from=build /opt /
COPY --from=codeserver /opt/code-server /opt/
RUN ln -s /opt/code-server/bin/code-server /usr/local/bin/code-server

COPY --chmod=755 services/devcontainer/scripts/entrypoint.sh /usr/local/bin/entrypoint

RUN mkdir -p \
          /home/coder/.config/Code/User \
          /home/coder/.local/share/code-server \
          /home/coder/.openclaw \
          /workspace \
          /projects \
     && chown -R coder:coder /home/coder /workspace

USER coder
WORKDIR /workspace

EXPOSE 8888

ENTRYPOINT ["entrypoint"]