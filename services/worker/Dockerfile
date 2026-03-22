FROM ubuntu:24.04

LABEL org.opencontainers.image.description="ClawForge worker v2 — agent OpenClaw autonome dev/qa"

# ── Dépendances système ────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates \
        python3 python3-pip python3-venv \
        build-essential jq \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── OpenClaw CLI ──────────────────────────────────────────────────────────────
RUN npm install -g openclaw 2>/dev/null || \
    (git clone --depth=1 https://github.com/openclaw/openclaw.git /opt/openclaw \
     && cd /opt/openclaw \
     && npm ci --omit=dev \
     && (npm run build 2>/dev/null || true) \
     && npm link)

# ── Git config ────────────────────────────────────────────────────────────────
RUN git config --global user.email "agent@clawforge.local" \
 && git config --global user.name  "ClawForge Agent" \
 && git config --global init.defaultBranch main \
 && git config --global pull.rebase false \
 && git config --global push.autoSetupRemote true

# ── Scripts worker ────────────────────────────────────────────────────────────
COPY services/worker/scripts/run-worker.sh  /usr/local/bin/run-worker.sh
COPY services/worker/scripts/gen-config.js  /opt/worker/gen-config.js
RUN chmod +x /usr/local/bin/run-worker.sh

# ── Skills ────────────────────────────────────────────────────────────────────
COPY services/agent/skills/docker-exec/              /opt/skills/docker-exec/
COPY services/worker/skills/git-flow/                /opt/skills/git-flow/
COPY services/worker/skills/agent-fanout/            /opt/skills/agent-fanout/
COPY services/worker/skills/staged-diff/             /opt/skills/staged-diff/
COPY services/worker/skills/codebase-analyze/        /opt/skills/codebase-analyze/
COPY services/worker/skills/session-handoff/         /opt/skills/session-handoff/
COPY services/worker/skills/semantic-memory/         /opt/skills/semantic-memory/
COPY services/worker/skills/project-context/         /opt/skills/project-context/
COPY services/worker/skills/frontend-design/         /opt/skills/frontend-design/
# System prompts des 11 spécialistes
COPY services/worker/skills/spec-init/              /opt/skills/spec-init/
COPY services/agent/specialists/                     /opt/specialists/
COPY services/worker/skills/loop-detect/ /opt/skills/loop-detect/
RUN chmod -R a+rX /opt/skills/ /opt/specialists/

# ── mcp-docs ──────────────────────────────────────────────────────────────────
COPY services/mcp-docs/ /opt/mcp-docs/
RUN cd /opt/mcp-docs && npm install --omit=dev

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/run-worker.sh"]
