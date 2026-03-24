#!/usr/bin/env node
/**
 * dev-manager.js — Ephemeral Code Server session manager
 *
 * Runs in the CHAT service (not the agent) because:
 *   - The chat receives /dev create commands from the user
 *   - The chat has the HOST Docker socket to create containers
 *   - The agent uses its internal rootless DinD for workers — different socket
 *
 * Docker socket:
 *   - /var/run/host-docker.sock → HOST Docker socket (mounted in chat)
 *   - DOCKER_HOST=unix:///var/run/host-docker.sock for dev container calls
 *   - NEVER use /var/run/docker.sock which would overwrite the internal DinD
 *
 * Port: DEV_MANAGER_PORT (default 9002)
 */
'use strict';

const http       = require('http');
const { execSync } = require('child_process');
const crypto     = require('crypto');

const PORT              = parseInt(process.env.DEV_MANAGER_PORT || '9002');
const HOST_DOCKER_SOCK  = process.env.HOST_DOCKER_SOCK  || '/var/run/host-docker.sock';
const DEVCONTAINER_IMAGE= process.env.DEVCONTAINER_IMAGE|| 'ghcr.io/pikatsuto/cdw-devcontainer:latest';
const DEVCONTAINER_MEM  = process.env.DEVCONTAINER_MEMORY || '4g';
const DEVCONTAINER_CPUS = process.env.DEVCONTAINER_CPUS   || '2.0';
const DEV_DOMAIN        = process.env.DEV_DOMAIN; // required — no default
const DEV_NETWORK       = process.env.DEV_NETWORK       || 'coolify';
const DEV_IDLE_MS       = parseInt(process.env.DEV_IDLE_MS || '1800000');
const GIT_PROVIDER_URL  = process.env.GIT_PROVIDER_1_URL || 'http://host-gateway:3000';
const GIT_TOKEN         = process.env.GIT_PROVIDER_1_TOKEN || process.env.FORGEJO_TOKEN || '';
const OLLAMA_URL        = process.env.OLLAMA_BASE_URL    || 'http://ollama:11434';
const OLLAMA_MODEL      = process.env.OLLAMA_MODEL       || 'qwen3.5:27b-q3_k_m';
const PROJECT_DATA_DIR  = process.env.PROJECT_DATA_DIR   || '/projects';

if (!DEV_DOMAIN) {
  console.error('[dev-manager] ❌ DEV_DOMAIN not defined — dev sessions disabled');
}

// Active sessions: sessionId → { containerId, containerName, userId, repo, url, startedAt, lastActivityAt }
const devSessions = new Map();

function log(msg) { console.log(`[dev-manager] ${new Date().toISOString().slice(11,19)} ${msg}`); }

function genId() { return crypto.randomBytes(4).toString('hex'); }

// Docker env pointing to HOST socket (not internal DinD)
function hostDockerEnv() {
  return { ...process.env, DOCKER_HOST: `unix://${HOST_DOCKER_SOCK}` };
}

function dockerCmd(cmd) {
  return execSync(cmd, { encoding: 'utf8', env: hostDockerEnv() }).trim();
}

// ── devCreate ─────────────────────────────────────────────────────────────────
async function devCreate({ userId, repo, password = '' }) {
  if (!DEV_DOMAIN) return { status: 'error', message: 'DEV_DOMAIN not configured' };

  // Session already active for this user
  for (const [sid, sess] of devSessions) {
    if (sess.userId === userId) {
      return { status: 'already_active', sessionId: sid, url: sess.url,
        message: `Session already active: ${sess.url}\nUse /dev release to close it.` };
    }
  }

  const sessionId     = genId();
  const containerName = `dev-${userId.replace(/[^a-z0-9]/gi, '-')}-${sessionId}`;
  const subdomain     = `dev-${sessionId}.${DEV_DOMAIN}`;
  const url           = `https://${subdomain}`;

  // Persistent volumes per user
  const volPrefix     = `dev_user_${userId.replace(/[^a-z0-9]/gi, '_')}`;
  const volVscode     = `${volPrefix}_vscode`;
  const volExtensions = `${volPrefix}_extensions`;
  const volOpenclaw   = `${volPrefix}_openclaw`;

  const envVars = [
    `USER_ID=${userId}`,
    `REPO=${repo || ''}`,
    `GIT_PROVIDER_1_URL=${GIT_PROVIDER_URL}`,
    `GIT_PROVIDER_1_TOKEN=${GIT_TOKEN}`,
    `OLLAMA_BASE_URL=${OLLAMA_URL}`,
    `OLLAMA_MODEL=${OLLAMA_MODEL}`,
    `PROJECT_DATA_DIR=${PROJECT_DATA_DIR}`,
    `CODE_SERVER_PASSWORD=${password}`,
    `SURFACE=vscode`,
    `STAGED_MODE=true`,
  ].map(e => `-e ${JSON.stringify(e)}`).join(' ');

  const labels = [
    `traefik.enable=true`,
    `traefik.http.routers.${containerName}.rule=Host(\`${subdomain}\`)`,
    `traefik.http.routers.${containerName}.entrypoints=https`,
    `traefik.http.routers.${containerName}.tls=true`,
    `traefik.http.routers.${containerName}.tls.certresolver=letsencrypt`,
    `traefik.http.routers.${containerName}.service=${containerName}-svc`,
    `traefik.http.services.${containerName}-svc.loadbalancer.server.port=8888`,
  ].map(l => `--label ${JSON.stringify(l)}`).join(' ');

  const volumes = [
    `-v ${volVscode}:/home/coder/.config/Code/User`,
    `-v ${volExtensions}:/home/coder/.local/share/code-server`,
    `-v ${volOpenclaw}:/home/coder/.openclaw`,
    `-v clawdevworker_project_data:${PROJECT_DATA_DIR}`,
  ].join(' ');

  const cmd = [
    'docker run -d --rm',
    `--name ${containerName}`,
    `--network ${DEV_NETWORK}`,
    `--memory ${DEVCONTAINER_MEM}`,
    `--cpus ${DEVCONTAINER_CPUS}`,
    '--add-host host-gateway:host-gateway',
    volumes,
    envVars,
    labels,
    DEVCONTAINER_IMAGE,
  ].join(' ');

  log(`spawn ${containerName} → ${url}`);

  try {
    const containerId = dockerCmd(cmd);
    devSessions.set(sessionId, {
      sessionId, containerId, containerName,
      userId, repo, url, subdomain,
      startedAt:      Date.now(),
      lastActivityAt: Date.now(),
    });
    log(`session ${sessionId} started`);
    return { status: 'started', sessionId, url,
      message: `🖥️ Code Server available in ~30s: ${url}`,
      password: password || '(none)' };
  } catch(e) {
    throw new Error(`docker run failed: ${e.message.slice(0, 200)}`);
  }
}

// ── devRelease ────────────────────────────────────────────────────────────────
function devRelease({ userId, sessionId }) {
  let targetId = sessionId;
  if (!targetId) {
    for (const [sid, sess] of devSessions) {
      if (sess.userId === userId) { targetId = sid; break; }
    }
  }
  const session = devSessions.get(targetId);
  if (!session) return { status: 'not_found', message: 'No active session.' };

  try {
    dockerCmd(`docker stop ${session.containerName} 2>/dev/null || true`);
  } catch {}

  devSessions.delete(targetId);
  log(`session ${targetId} released`);
  return { status: 'released', sessionId: targetId,
    message: 'Session closed. VSCode profile preserved for the next session.' };
}

// ── devStatus ─────────────────────────────────────────────────────────────────
function devStatus() {
  return {
    activeSessions: devSessions.size,
    sessions: [...devSessions.values()].map(s => ({
      sessionId:    s.sessionId,
      userId:       s.userId,
      repo:         s.repo,
      url:          s.url,
      uptime:       Math.round((Date.now() - s.startedAt) / 60000) + 'min',
      lastActivity: Math.round((Date.now() - s.lastActivityAt) / 60000) + 'min ago',
    })),
  };
}

// ── Poll idle sessions ────────────────────────────────────────────────────────
setInterval(() => {
  for (const [sid, sess] of devSessions) {
    if (Date.now() - sess.lastActivityAt > DEV_IDLE_MS) {
      log(`session ${sid} idle → automatic shutdown`);
      devRelease({ userId: sess.userId, sessionId: sid });
    }
  }
}, 5 * 60 * 1000);

// ── HTTP Server ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // POST /dev/create
  if (req.method === 'POST' && req.url === '/dev/create') {
    const body = await readBody(req);
    if (!body.userId) return json(400, { error: 'userId required' });
    try {
      const result = await devCreate(body);
      return json(result.status === 'started' ? 200 : 202, result);
    } catch(e) {
      return json(500, { error: e.message });
    }
  }

  // POST /dev/release
  if (req.method === 'POST' && req.url === '/dev/release') {
    const body = await readBody(req);
    if (!body.userId) return json(400, { error: 'userId required' });
    return json(200, devRelease(body));
  }

  // GET /dev/status
  if (req.method === 'GET' && req.url === '/dev/status') {
    return json(200, devStatus());
  }

  // POST /dev/heartbeat — Code Server ping to prevent idle timeout
  if (req.method === 'POST' && req.url === '/dev/heartbeat') {
    const body = await readBody(req);
    const sess = devSessions.get(body.sessionId);
    if (sess) sess.lastActivityAt = Date.now();
    res.writeHead(200); res.end('ok');
    return;
  }

  // GET /healthz
  if (req.url === '/healthz') {
    res.writeHead(200); res.end('ok');
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  log(`dev-manager started on :${PORT}`);
  log(`host Docker socket: ${HOST_DOCKER_SOCK}`);
  log(`dev domain: ${DEV_DOMAIN || '⚠️  NOT CONFIGURED'}`);
});
