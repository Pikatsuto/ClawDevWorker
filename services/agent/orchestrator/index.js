#!/usr/bin/env node
/**
 * orchestrator/index.js — OpenClaw multi-agent plugin v2
 *
 * Exposes 4 tools to the OpenClaw agent:
 *   task_pickup      → pick an issue, reserve GPU, spawn specialist worker
 *   task_complete    → finish a task (done/pass/fail/refine)
 *   queue_status     → queue state and active workers
 *   session_health   → detect and correct state inconsistencies
 *
 * Per-project configurable RBAC pipeline (.coderclaw/rules.yaml in repo):
 *   gates: [architect, frontend, marketing, qa, doc]
 *   require_all: true
 *
 * Specialist routing:
 *   1. Git labels (manual override)
 *   2. CPU analyzes the issue → determines required specialist(s)
 *
 * Simultaneous Forgejo + GitHub support via git-provider abstraction.
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

// POST /webhook          → Forgejo/GitHub events
// POST /scheduler-event  → internal GPU scheduler events
// GET  /health, /healthz → healthcheck

const ORCHESTRATOR_PORT = parseInt(process.env.ORCHESTRATOR_PORT || '9001');

// Git providers loaded at startup
let gitProviders;
try {
  const gp = require('/opt/git-provider/index.js');
  gitProviders = gp.loadProviders();
  log(`Git providers loaded: ${gitProviders.size}`);
} catch(e) {
  log(`Git provider not available: ${e.message}`, 'WARN');
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

  // ── Forgejo / GitHub webhook ───────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/webhook') {
    const rawBody = await readRawBody(req);
    let body;
    try { body = JSON.parse(rawBody); } catch { body = {}; }

    // Provider detection
    let provider = null;
    if (gitProviders.size > 0) {
      const { detectProvider } = require('/opt/git-provider/index.js');
      const info = detectProvider(req, gitProviders);
      if (info) {
        provider = info.provider;
        // Signature verification
        const sig = req.headers['x-hub-signature-256'] || req.headers['x-gitea-signature'] || '';
        if (sig && !provider.verifyWebhook(rawBody, sig)) {
          log('Invalid webhook signature', 'WARN');
          res.writeHead(403); res.end('Invalid signature'); return;
        }
      }
    }

    // Event parsing (Forgejo or GitHub depending on headers)
    let event;
    if (provider) {
      event = provider.parseWebhook(req.headers, body);
    } else {
      // Fallback: manual parsing
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

    // ── Issue assigned to agent account → start pipeline ────────────────────
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
          .then(r => log(`Pipeline started: ${event.repo}#${event.issue.id}`))
          .catch(e => {
            log(`Pipeline error: ${e.message}`, 'WARN');
            if (provider) provider.addComment(event.repo, event.issue.id,
              `⚠️ Pipeline start error: ${e.message}`).catch(() => {});
          });
      }
    }

    // ── /retry comment → restart the pipeline ───────────────────────────────
    if (event.type === 'comment' && event.comment?.body?.trim() === '/retry' && event.repo) {
      const issueId = event.issueId;
      if (issueId) {
        if (provider) provider.removeLabel(event.repo, issueId, 'needs-human').catch(() => {});
        task_pickup({ repo: event.repo, issueId })
          .catch(e => {
            if (provider) provider.addComment(event.repo, issueId,
              `⚠️ Retry failed: ${e.message}`).catch(() => {});
          });
      }
    }

    // ── PR opened with gate:xxx label → trigger that gate ──────────────────
    if ((event.type === 'pr.opened' || event.type === 'pr.synchronize') && event.pr && event.repo) {
      const gateLabel = (event.pr.labels || []).find(l => l.startsWith('gate:'));
      if (gateLabel) {
        const gate     = gateLabel.replace('gate:', '');
        const issueM   = (event.pr.body || '').match(/#(\d+)/);
        if (issueM && SPECIALISTS.includes(gate)) {
          task_pickup({ repo: event.repo, issueId: parseInt(issueM[1]), role: gate })
            .catch(e => log(`PR gate error: ${e.message}`, 'WARN'));
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
      res.writeHead(400); res.end('repo, issueId, deps[] required'); return;
    }
    registerDeps(repo, issueId, deps);
    log(`DAG: #${issueId} on ${repo} → depends on [${deps.join(', ')}]`);
    audit('deps_registered', { repo, issueId, deps });
    res.writeHead(200); res.end(JSON.stringify({ ok: true, issueId, deps }));
    return;
  }
  if (req.method === 'POST' && req.url === '/scheduler-event') {
    const body = await readBody(req);
    log(`Scheduler event: ${body.event} taskId=${body.taskId}`);

    if (body.event === 'slot-ready') {
      const parts   = (body.taskId || '').split(':');
      const repo    = parts[0];
      const issueId = parseInt(parts[1]);
      const role    = parts[2] || 'fullstack';
      if (repo && issueId) {
        task_pickup({ repo, issueId, role, forceModel: body.modelId })
          .then(() => log(`Auto-pickup: ${repo}#${issueId} role=${role}`))
          .catch(e => log(`Auto-pickup error: ${e.message}`, 'WARN'));
      }
    }

    if (body.event === 'pause')  log(`Pause task ${body.taskId}`);
    if (body.event === 'resume') log(`Resume task ${body.taskId}`);

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
  log(`Orchestrator started :${ORCHESTRATOR_PORT} (${gitProviders.size} providers)`);
});

// ── OpenClaw plugin export ────────────────────────────────────────────────────

module.exports = {
  tools: [
    {
      name: 'task_pickup',
      description: 'Start the RBAC pipeline on an issue. Automatically routes to specialists (architect, frontend, backend, fullstack, devops, qa, doc, marketing, design, product, bizdev) based on content and project rules.yaml.',
      parameters: {
        type: 'object',
        required: ['repo', 'issueId'],
        properties: {
          repo:            { type: 'string', description: 'Repo in owner/repo format' },
          issueId:         { type: 'number', description: 'Issue number' },
          role:            { type: 'string', enum: ['architect','frontend','backend','fullstack','devops','security','qa','doc','marketing','design','product','bizdev'], description: 'Force a specialist (optional)' },
          forceModel:      { type: 'string', description: 'Force an Ollama model (optional)' },
          forceComplexity: { type: 'string', enum: ['simple','standard','complex'], description: 'Force complexity (optional)' },
        },
      },
      handler: task_pickup,
    },
    {
      name: 'task_complete',
      description: "Finish a pipeline gate. done/pass → advance to next gate. fail → automatic retry (3x max) then human escalation. refine → note and continue.",
      parameters: {
        type: 'object',
        required: ['repo', 'issueId', 'role', 'result'],
        properties: {
          repo:     { type: 'string' },
          issueId:  { type: 'number' },
          role:     { type: 'string', enum: ['architect','frontend','backend','fullstack','devops','security','qa','doc','marketing','design','product','bizdev'] },
          result:   { type: 'string', enum: ['done','pass','fail','refine'] },
          summary:  { type: 'string', description: 'Summary of work done or problems found' },
          prNumber: { type: 'number', description: 'Related PR number (optional)' },
        },
      },
      handler: task_complete,
    },
    {
      name: 'queue_status',
      description: 'Queue state and active workers for a repo.',
      parameters: {
        type: 'object',
        properties: { repo: { type: 'string' } },
      },
      handler: queue_status,
    },
    {
      name: 'session_health',
      description: 'Check and correct inconsistencies (blocked workers, orphaned containers).',
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
