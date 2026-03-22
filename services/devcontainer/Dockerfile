###############################################################################
# kasm-devcontainer — Image de base pour les sessions dev éphémères
#
# Remplace kasm-openclaw (Kasm VNC/XFCE).
# Contient :
#   - Code Server (VSCode dans le navigateur)
#   - OpenClaw gateway (depuis coollabsio/openclaw, configure.js inclus)
#   - Stacks dev : Node 22 + Python 3 + Rust + Go + Git
#   - Nos skills + config VSCode identique à l'ancien kasm-openclaw
#
# Usage : container éphémère spawné dynamiquement par l'orchestrateur
#   - Volume par user : ~/.config/Code/User + extensions + ~/.openclaw
#   - Repo cloné dans /workspace au démarrage
#   - Devcontainer.json du repo → postCreateCommand exécuté si présent
#   - Détruit à /dev release (--rm)
###############################################################################

# ── Stage 1 : OpenClaw depuis coollabsio (configure.js + nginx inclus) ────────
FROM coollabsio/openclaw:latest AS openclaw-base

# ── Stage 2 : Image finale ────────────────────────────────────────────────────
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG CODE_SERVER_VERSION=4.95.3

ENV HOME=/home/coder \
    USER=coder \
    SHELL=/bin/bash \
    PATH=/home/coder/.cargo/bin:/usr/local/go/bin:/home/coder/.local/bin:$PATH

# ── Utilisateur coder (non-root) ──────────────────────────────────────────────
# Ubuntu 24.04 crée un user "ubuntu" avec UID 1000 par défaut — on le supprime
RUN userdel -r ubuntu 2>/dev/null || true \
 && groupdel ubuntu 2>/dev/null || true \
 && groupadd --gid 1000 coder \
 && useradd --uid 1000 --gid coder --shell /bin/bash --create-home coder

# ── Dépendances système ───────────────────────────────────────────────────────
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
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path \
 && /root/.cargo/bin/rustup default stable \
 && cp -r /root/.cargo /home/coder/.cargo \
 && cp -r /root/.rustup /home/coder/.rustup \
 && chown -R coder:coder /home/coder/.cargo /home/coder/.rustup

# ── Code Server ───────────────────────────────────────────────────────────────
RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
      -o /tmp/code-server.deb \
 && dpkg -i /tmp/code-server.deb \
 && rm /tmp/code-server.deb

# ── OpenClaw — copié depuis coollabsio ────────────────────────────────────────
COPY --from=openclaw-base /usr/local/lib/node_modules/openclaw /opt/openclaw
COPY --from=openclaw-base /usr/local/bin/openclaw /usr/local/bin/openclaw
COPY --from=openclaw-base /scripts /opt/openclaw-scripts
# configure.js de coollabsio — génère openclaw.json depuis env vars
COPY --from=openclaw-base /scripts/configure.js /opt/openclaw-scripts/configure.js

# ── mcp-docs ──────────────────────────────────────────────────────────────────
COPY services/mcp-docs/ /opt/mcp-docs/
RUN cd /opt/mcp-docs && npm install --omit=dev

# ── git-provider (pour /project status dans Code Server) ─────────────────────
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

# ── Config VSCode (identique à l'ancien kasm-openclaw) ────────────────────────
# Copiée dans /opt pour être installée dans le volume user au premier démarrage
COPY services/devcontainer/config/vscode/settings.json \
     /opt/devcontainer/config/vscode/settings.json
COPY services/devcontainer/config/vscode/extensions.txt \
     /opt/devcontainer/config/vscode/extensions.txt

# ── Script de démarrage ───────────────────────────────────────────────────────
COPY services/devcontainer/scripts/start-devcontainer.sh /start.sh
RUN chmod +x /start.sh

# ── Répertoires de volumes (créés pour la clarté) ─────────────────────────────
# Ces chemins seront montés en volumes par user au runtime
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
