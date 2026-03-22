###############################################################################
# kasm-devcontainer — Base image for ephemeral dev sessions
#
# Replaces kasm-openclaw (Kasm VNC/XFCE).
# Contains:
#   - Code Server (VSCode in the browser)
#   - OpenClaw gateway (from coollabsio/openclaw, configure.js included)
#   - Dev stacks: Node 22 + Python 3 + Rust + Go + Git
#   - Our skills + VSCode config identical to the old kasm-openclaw
#
# Usage: ephemeral container dynamically spawned by the orchestrator
#   - Per-user volume: ~/.config/Code/User + extensions + ~/.openclaw
#   - Repo cloned into /workspace at startup
#   - Repo's devcontainer.json → postCreateCommand executed if present
#   - Destroyed on /dev release (--rm)
###############################################################################

# ── Stage 1: OpenClaw from coollabsio (configure.js + nginx included) ────────
FROM coollabsio/openclaw:latest AS openclaw-base

# ── Stage 2: Final image ─────────────────────────────────────────────────────
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG CODE_SERVER_VERSION=4.95.3

ENV HOME=/home/coder \
    USER=coder \
    SHELL=/bin/bash \
    PATH=/home/coder/.cargo/bin:/usr/local/go/bin:/home/coder/.local/bin:$PATH

# ── Coder user (non-root) ────────────────────────────────────────────────────
# Ubuntu 24.04 creates a default "ubuntu" user with UID 1000 — remove it
RUN userdel -r ubuntu 2>/dev/null || true \
 && groupdel ubuntu 2>/dev/null || true \
 && groupadd --gid 1000 coder \
 && useradd --uid 1000 --gid coder --shell /bin/bash --create-home coder

# ── System dependencies ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl wget git ca-certificates gnupg \
        build-essential pkg-config libssl-dev \
        python3 python3-pip python3-venv python3-dev \
        jq htop tree ripgrep fzf \
        openssh-client \
        unzip zip \
        nginx \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 LTS ───────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g yarn pnpm typescript ts-node

# ── Go 1.22 ───────────────────────────────────────────────────────────────────
RUN curl -fsSL "https://go.dev/dl/go1.22.5.linux-amd64.tar.gz" \
      -o /tmp/go.tar.gz \
 && tar -C /usr/local -xzf /tmp/go.tar.gz \
 && rm /tmp/go.tar.gz

# ── Rust ──────────────────────────────────────────────────────────────────────
# Download rustup-init binary directly (skip shell script to avoid dash/buildx issues)
RUN curl -fsSL "https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init" -o /tmp/rustup-init \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --default-toolchain stable \
 && rm /tmp/rustup-init \
 && cp -r /root/.cargo /home/coder/.cargo \
 && cp -r /root/.rustup /home/coder/.rustup \
 && chown -R coder:coder /home/coder/.cargo /home/coder/.rustup

# ── Code Server ───────────────────────────────────────────────────────────────
RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
      -o /tmp/code-server.deb \
 && dpkg -i /tmp/code-server.deb \
 && rm /tmp/code-server.deb

# ── OpenClaw — copied from coollabsio ────────────────────────────────────────
# openclaw is installed at /opt/openclaw in the upstream image
# binary at /usr/local/bin/openclaw → exec node /opt/openclaw/app/openclaw.mjs
COPY --from=openclaw-base /opt/openclaw /opt/openclaw
COPY --from=openclaw-base /usr/local/bin/openclaw /usr/local/bin/openclaw
COPY --from=openclaw-base /app/scripts /opt/openclaw-scripts

# ── mcp-docs ──────────────────────────────────────────────────────────────────
COPY services/mcp-docs/ /opt/mcp-docs/
RUN cd /opt/mcp-docs && npm install --omit=dev

# ── git-provider (for /project status in Code Server) ─────────────────────────
COPY services/git-provider/ /opt/git-provider/

# ── Skills ────────────────────────────────────────────────────────────────────
COPY services/worker/skills/staged-diff/      /opt/skills/staged-diff/
COPY services/worker/skills/codebase-analyze/ /opt/skills/codebase-analyze/
COPY services/worker/skills/session-handoff/  /opt/skills/session-handoff/
COPY services/worker/skills/semantic-memory/  /opt/skills/semantic-memory/
COPY services/worker/skills/project-context/  /opt/skills/project-context/
COPY services/worker/skills/frontend-design/  /opt/skills/frontend-design/
COPY services/worker/skills/loop-detect/      /opt/skills/loop-detect/
COPY services/worker/skills/spec-init/        /opt/skills/spec-init/
COPY services/agent/specialists/              /opt/specialists/
COPY services/devcontainer/skills/gpu-dispatch/       /opt/skills/gpu-dispatch/
COPY services/devcontainer/skills/cpu-status/         /opt/skills/cpu-status/
COPY services/devcontainer/skills/bmad/               /opt/skills/bmad/
COPY services/devcontainer/skills/user-token/         /opt/skills/user-token/
COPY services/devcontainer/skills/git-provider-chat/  /opt/skills/git-provider-chat/
RUN mkdir -p /opt/scripts/spec
COPY services/chat/scripts/spec/spec-init.js          /opt/scripts/spec/spec-init.js
RUN chmod -R a+rX /opt/skills/ /opt/specialists/ /opt/openclaw-scripts/ /opt/scripts/

# ── VSCode config (identical to the old kasm-openclaw) ────────────────────────
# Copied to /opt to be installed into the user volume on first startup
COPY services/devcontainer/config/vscode/settings.json \
     /opt/devcontainer/config/vscode/settings.json
COPY services/devcontainer/config/vscode/extensions.txt \
     /opt/devcontainer/config/vscode/extensions.txt

# ── Startup script ────────────────────────────────────────────────────────────
COPY services/devcontainer/scripts/start-devcontainer.sh /start.sh
RUN chmod +x /start.sh

# ── Volume directories (created for clarity) ──────────────────────────────────
# These paths will be mounted as per-user volumes at runtime
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

CMD ["/start.sh"]
