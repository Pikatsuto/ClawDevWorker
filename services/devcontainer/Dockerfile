###############################################################################
# devcontainer — Base image for dev sessions
#
# Base: docker:dind-rootless (Alpine + rootless Docker for devcontainers)
#
# Contains:
#   - Code Server (VSCode in the browser)
#   - sshd (VSCode Remote SSH from local client)
#   - OpenClaw gateway (from coollabsio/openclaw)
#   - Dev stacks: Node + Python 3 + Rust + Go + Git
#   - Skills + VSCode config
#
# Usage: container dynamically spawned by the chat via /dev create
#   - Per-user volume: ~/.config/Code/User + extensions + ~/.openclaw
#   - Repo cloned into /workspace at startup
#   - VSCode detects devcontainer.json → "Reopen in Container" via DinD
#   - Destroyed on /dev release (--rm)
###############################################################################

# ── Stage 1: OpenClaw from coollabsio ──────────────────────────────────────
FROM coollabsio/openclaw:latest AS openclaw-base

# ── Stage 2: base ──────────────────────────────────────────────────────────
FROM docker:dind-rootless AS base
USER root

RUN deluser rootless 2>/dev/null; delgroup rootless 2>/dev/null; \
     addgroup -g 1000 coder \
     && adduser -u 1000 -G coder -s /bin/bash -D coder

ENV HOME=/home/coder \
    USER=coder \
    SHELL=/bin/bash \
    PATH=/home/coder/.cargo/bin:/usr/local/go/bin:/home/coder/.local/bin:$PATH

RUN apk add --no-cache \
        curl wget git ca-certificates gnupg bash \
        build-base pkgconf openssl-dev \
        python3 py3-pip py3-virtualenv python3-dev \
        jq htop tree ripgrep fzf \
        openssh-client openssh-server \
        unzip zip \
        nodejs npm \
        go rust cargo

RUN npm install -g yarn pnpm typescript ts-node

# ── Stage 3: build ─────────────────────────────────────────────────────────
FROM base AS build

COPY --from=openclaw-base /opt/openclaw /opt/openclaw
COPY --from=openclaw-base /usr/local/bin/openclaw /usr/local/bin/openclaw
COPY --from=openclaw-base /app/scripts /opt/openclaw-scripts/

# Copy sources + project root config for tsc
COPY tsconfig.json package.json package-lock.json /build/
COPY shared /build/shared
COPY services/devcontainer /build/services/devcontainer

# Install dev deps (typescript) + compile
RUN cd /build && npm ci \
 && npx tsc \
 && cp -r /build/dist/shared/opt/* /opt/ \
 && cp -r /build/dist/services/devcontainer/opt/* /opt/

# Copy non-TS assets (SKILL.md, config, etc.)
COPY shared /
COPY services/devcontainer /

# Install runtime npm deps
RUN cd /opt/mcp-docs && npm install --omit=dev \
    && npm install -g better-sqlite3 \
    && chmod -R a+rX /opt/

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

COPY --from=build /opt/ /opt/
COPY --from=codeserver /opt/code-server /opt/
RUN ln -s /opt/code-server/bin/code-server /usr/local/bin/code-server

COPY --chmod=755 services/devcontainer/scripts/entrypoint.sh /usr/local/bin/entrypoint

RUN mkdir -p \
          /home/coder/.config/Code/User \
          /home/coder/.local/share/code-server \
          /home/coder/.openclaw \
          /home/coder/.ssh \
          /workspace \
          /projects \
     && chown -R coder:coder /home/coder /workspace

USER coder
WORKDIR /workspace

EXPOSE 8888 22

ENTRYPOINT ["entrypoint"]
