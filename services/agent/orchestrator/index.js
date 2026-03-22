#!/usr/bin/env node
/**
 * orchestrator/index.js — Plugin OpenClaw multi-agent v2
 *
 * Expose 4 outils à l'agent OpenClaw :
 *   task_pickup      → prendre une issue, réserver GPU, spawner worker spécialiste
 *   task_complete    → terminer une tâche (done/pass/fail/refine)
 *   queue_status     → état de la queue et des workers actifs
 *   session_health   → détecter et corriger les incohérences d'état
 *
 * Pipeline RBAC configurable par projet (.coderclaw/rules.yaml dans le repo) :
 *   gates: [architect, frontend, marketing, qa, doc]
 *   require_all: true
 *
 * Routing spécialistes :
 *   1. Labels git (override manuel)
 *   2. CPU analyse l'issue → détermine le(s) spécialiste(s)
 *
 * Support simultané Forgejo + GitHub via git-provider abstraction.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────

const FORGEJO_URL       = process.env.FORGEJO_URL       || 'http://host-gateway:3000';
const FORGEJO_TOKEN     = process.env.FORGEJO_TOKEN     || '';
const SCHEDULER_URL     = process.env.SCHEDULER_URL     || 'http://localhost:7070';
const OLLAMA_CPU_URL    = process.env.OLLAMA_CPU_URL    || 'http://ollama-cpu:11434';
const MEMORY_DIR        = process.env.MEMORY_DIR        || path.join(process.env.HOME || '/root', '.openclaw/workspace/memory');
const PROJECTS_FILE     = path.join(MEMORY_DIR, 'projects.json');
const AUDIT_FILE        = path.join(MEMORY_DIR, 'audit.log');
const WORKER_IMAGE      = process.env.WORKER_IMAGE      || 'ghcr.io/pikatsuto/cdw-worker:latest';
const WORKER_MEMORY     = process.env.WORKER_MEMORY     || '2g';

// POST /webhook          → événements Forgejo/GitHub
// POST /scheduler-event  → événements internes GPU scheduler
// GET  /health, /healthz → healthcheck

const ORCHESTRATOR_PORT = parseInt(process.env.ORCHESTRATOR_PORT || '9001');

// Git providers chargés au démarrage
let gitProviders;
try {
  const gp = require('/opt/git-provider/index.js');
  gitProviders = gp.loadProviders();
  log(`Git providers chargés : ${gitProviders.size}`);
} catch(e) {
  log(`Git provider non disponible : ${e.message}`, 'WARN');
  gitProviders = new Map();
}

function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });
}

function readRawBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => resolve(d));
  });
}

const server = http.createServer(async (req, res) => {

  // ── Webhook Forgejo / GitHub ───────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/webhook') {
    const rawBody = await readRawBody(req);
    let body;
    try { body = JSON.parse(rawBody); } catch { body = {}; }

    // Détection provider
    let provider = null;
    if (gitProviders.size > 0) {
      const { detectProvider } = require('/opt/git-provider/index.js');
      const info = detectProvider(req, gitProviders);
      if (info) {
        provider = info.provider;
        // Vérification signature
        const sig = req.headers['x-hub-signature-256'] || req.headers['x-gitea-signature'] || '';
        if (sig && !provider.verifyWebhook(rawBody, sig)) {
          log('Signature webhook invalide', 'WARN');
          res.writeHead(403); res.end('Invalid signature'); return;
        }
      }
    }

    // Parsing de l'événement (Forgejo ou GitHub selon les headers)
    let event;
    if (provider) {
      event = provider.parseWebhook(req.headers, body);
    } else {
      // Fallback : parsing manuel
      const gitEvent = req.headers['x-gitea-event'] || req.headers['x-forgejo-event'] || req.headers['x-github-event'] || '';
      event = {
        type:    gitEvent === 'issues' && body.action === 'assigned' ? 'issue.assigned' : `${gitEvent}.${body.action}`,
        repo:    body.repository?.full_name,
        issue:   body.issue ? { id: body.issue.number, title: body.issue.title,
                   body: body.issue.body || '', labels: (body.issue.labels||[]).map(l=>l.name),
                   assignee: body.issue.assignee?.login } : null,
        pr:      body.pull_request ? { id: body.pull_request.number, title: body.pull_request.title,
                   body: body.pull_request.body || '', labels: (body.pull_request.labels||[]).map(l=>l.name) } : null,
        comment: body.comment ? { body: body.comment.body } : null,
        issueId: body.issue?.number,
      };
    }

    log(`Webhook ${event.type} repo=${event.repo}`);

    // ── Issue assignée au compte agent → démarrer pipeline ─────────────────
    if (event.type === 'issue.assigned' && event.issue && event.repo) {
      const agentLogin = process.env.AGENT_GIT_LOGIN || 'agent';
      if (event.issue.assignee !== agentLogin) {
        res.writeHead(200); res.end('ok'); return;
      }
      const { project } = getProject(event.repo);
      const alreadyActive = SPECIALISTS.some(r =>
        project[r]?.active && project[r]?.issueId === event.issue.id
      );
      if (!alreadyActive) {
        task_pickup({ repo: event.repo, issueId: event.issue.id })
          .then(r => log(`Pipeline démarré: ${event.repo}#${event.issue.id}`))
          .catch(e => {
            log(`Erreur pipeline: ${e.message}`, 'WARN');
            if (provider) provider.addComment(event.repo, event.issue.id,
              `⚠️ Erreur démarrage pipeline: ${e.message}`).catch(() => {});
          });
      }
    }

    // ── Commentaire /retry → relancer le pipeline ───────────────────────────
    if (event.type === 'comment' && event.comment?.body?.trim() === '/retry' && event.repo) {
      const issueId = event.issueId;
      if (issueId) {
        if (provider) provider.removeLabel(event.repo, issueId, 'needs-human').catch(() => {});
        task_pickup({ repo: event.repo, issueId })
          .catch(e => {
            if (provider) provider.addComment(event.repo, issueId,
              `⚠️ Retry échoué: ${e.message}`).catch(() => {});
          });
      }
    }

    // ── PR ouverte avec label gate:xxx → déclencher ce gate ────────────────
    if ((event.type === 'pr.opened' || event.type === 'pr.synchronize') && event.pr && event.repo) {
      const gateLabel = (event.pr.labels || []).find(l => l.startsWith('gate:'));
      if (gateLabel) {
        const gate     = gateLabel.replace('gate:', '');
        const issueM   = (event.pr.body || '').match(/#(\d+)/);
        if (issueM && SPECIALISTS.includes(gate)) {
          task_pickup({ repo: event.repo, issueId: parseInt(issueM[1]), role: gate })
            .catch(e => log(`Erreur gate PR: ${e.message}`, 'WARN'));
        }
      }
    }

    res.writeHead(200); res.end('ok');
    return;
  }

  // POST /deps { repo, issueId, deps: ['1', '2'] }
  // Appelé par create-issues.js après la création des issues
  if (req.method === 'POST' && req.url === '/deps') {
    const body = await readBody(req);
    const { repo, issueId, deps } = body;
    if (!repo || !issueId || !Array.isArray(deps)) {
      res.writeHead(400); res.end('repo, issueId, deps[] requis'); return;
    }
    registerDeps(repo, issueId, deps);
    log(`DAG: #${issueId} sur ${repo} → dépend de [${deps.join(', ')}]`);
    audit('deps_registered', { repo, issueId, deps });
    res.writeHead(200); res.end(JSON.stringify({ ok: true, issueId, deps }));
    return;
  }
  if (req.method === 'POST' && req.url === '/scheduler-event') {
    const body = await readBody(req);
    log(`Événement scheduler: ${body.event} taskId=${body.taskId}`);

    if (body.event === 'slot-ready') {
      const parts   = (body.taskId || '').split(':');
      const repo    = parts[0];
      const issueId = parseInt(parts[1]);
      const role    = parts[2] || 'fullstack';
      if (repo && issueId) {
        task_pickup({ repo, issueId, role, forceModel: body.modelId })
          .then(() => log(`Auto-pickup: ${repo}#${issueId} role=${role}`))
          .catch(e => log(`Auto-pickup erreur: ${e.message}`, 'WARN'));
      }
    }

    if (body.event === 'pause')  log(`Pause tâche ${body.taskId}`);
    if (body.event === 'resume') log(`Reprise tâche ${body.taskId}`);

    res.writeHead(200); res.end('ok');
    return;
  }

  // ── Healthcheck ─────────────────────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, providers: gitProviders.size }));
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(ORCHESTRATOR_PORT, '0.0.0.0', () => {
  log(`Orchestrateur démarré :${ORCHESTRATOR_PORT} (${gitProviders.size} providers)`);
});

// ── Export pour OpenClaw plugin ────────────────────────────────────────────────

module.exports = {
  tools: [
    {
      name: 'task_pickup',
      description: 'Démarrer le pipeline RBAC sur une issue. Route automatiquement vers les spécialistes (architect, frontend, backend, fullstack, devops, qa, doc, marketing, design, product, bizdev) selon le contenu et le rules.yaml du projet.',
      parameters: {
        type: 'object',
        required: ['repo', 'issueId'],
        properties: {
          repo:            { type: 'string', description: 'Repo au format owner/repo' },
          issueId:         { type: 'number', description: "Numéro de l'issue" },
          role:            { type: 'string', enum: ['architect','frontend','backend','fullstack','devops','security','qa','doc','marketing','design','product','bizdev'], description: 'Forcer un spécialiste (optionnel)' },
          forceModel:      { type: 'string', description: 'Forcer un modèle Ollama (optionnel)' },
          forceComplexity: { type: 'string', enum: ['simple','standard','complex'], description: 'Forcer la complexité (optionnel)' },
        },
      },
      handler: task_pickup,
    },
    {
      name: 'task_complete',
      description: "Terminer un gate du pipeline. done/pass → avance au gate suivant. fail → retry automatique (3x max) puis escalade humaine. refine → note et continue.",
      parameters: {
        type: 'object',
        required: ['repo', 'issueId', 'role', 'result'],
        properties: {
          repo:     { type: 'string' },
          issueId:  { type: 'number' },
          role:     { type: 'string', enum: ['architect','frontend','backend','fullstack','devops','security','qa','doc','marketing','design','product','bizdev'] },
          result:   { type: 'string', enum: ['done','pass','fail','refine'] },
          summary:  { type: 'string', description: 'Résumé du travail ou des problèmes trouvés' },
          prNumber: { type: 'number', description: 'Numéro PR concernée (optionnel)' },
        },
      },
      handler: task_complete,
    },
    {
      name: 'queue_status',
      description: 'État de la queue et des workers actifs pour un repo.',
      parameters: {
        type: 'object',
        properties: { repo: { type: 'string' } },
      },
      handler: queue_status,
    },
    {
      name: 'session_health',
      description: 'Vérifier et corriger les incohérences (workers bloqués, containers orphelins).',
      parameters: {
        type: 'object',
        properties: {
          autoFix:          { type: 'boolean', default: false },
          activeContainers: { type: 'array', items: { type: 'string' } },
        },
      },
      handler: session_health,
    },
  ],
};
