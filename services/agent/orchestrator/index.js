#!/usr/bin/env node
/**
 * orchestrator/index.js — Pipeline orchestrator v3
 *
 * Single-PR pipeline: all gates run sequentially on the same feature branch.
 * The human only sees one clean, reviewed, tested PR per issue.
 *
 * Flow:
 *   1. Issue assigned to agent → read rules.yaml → determine gates
 *   2. Create feature branch, run gates sequentially (each gate = one worker)
 *   3. Each worker commits on the shared branch, exits when done
 *   4. After all gates pass → open PR (or update existing)
 *   5. Human reviews → comments trigger re-run of relevant gates
 *   6. /stop → freeze pipeline until human says go
 *   7. Post-merge comment → resume on same branch
 *
 * Webhook events:
 *   POST /webhook          → Forgejo/GitHub events
 *   POST /deps             → DAG dependency registration
 *   POST /scheduler-event  → GPU scheduler events
 *   GET  /health           → healthcheck
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const { execSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────

const SCHEDULER_URL     = process.env.SCHEDULER_URL     || 'http://localhost:7070';
const OLLAMA_CPU_URL    = process.env.OLLAMA_CPU_URL    || 'http://ollama-cpu:11434';
const ORCHESTRATOR_PORT = parseInt(process.env.ORCHESTRATOR_PORT || '9001');
const WORKER_IMAGE      = process.env.WORKER_IMAGE      || 'ghcr.io/pikatsuto/cdw-worker:latest';
const AGENT_LOGIN       = process.env.AGENT_GIT_LOGIN   || 'agent';
const STATE_DIR         = process.env.STATE_DIR          || path.join(process.env.HOME || '/root', '.openclaw/orchestrator');
const STATE_FILE        = path.join(STATE_DIR, 'pipelines.json');
const AUDIT_FILE        = path.join(STATE_DIR, 'audit.log');
const MAX_RETRIES       = parseInt(process.env.GATE_MAX_RETRIES || '3');
const RETRY_UPGRADE     = process.env.GATE_RETRY_UPGRADE !== 'false';

const SPECIALISTS = [
  'architect','frontend','backend','fullstack','devops',
  'security','qa','doc','marketing','design','product','bizdev',
];

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg, level = 'INFO') {
  console.log(`[orchestrator] ${new Date().toISOString()} [${level}] ${msg}`);
}

function audit(action, data) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE,
      `${new Date().toISOString()} ${action} ${JSON.stringify(data)}\n`);
  } catch {}
}

// ── Git providers ─────────────────────────────────────────────────────────────

let gitProviders;
try {
  const gp = require('/opt/git-provider/index.js');
  gitProviders = gp.loadProviders();
  log(`Git providers loaded: ${gitProviders.size}`);
} catch (e) {
  log(`Git provider error: ${e.message}`, 'WARN');
  gitProviders = new Map();
}

function getProvider(repo) {
  const { getProviderForRepo } = require('/opt/git-provider/index.js');
  return getProviderForRepo(repo, gitProviders);
}

// ── Pipeline state ────────────────────────────────────────────────────────────
// State is persisted to disk so pipelines survive restarts.
// Key: "owner/repo#issueId"

let pipelines = {};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      pipelines = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
}

function saveState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(pipelines, null, 2));
  } catch {}
}

function getPipeline(repo, issueId) {
  const key = `${repo}#${issueId}`;
  return pipelines[key] || null;
}

function setPipeline(repo, issueId, data) {
  const key = `${repo}#${issueId}`;
  pipelines[key] = { ...data, updatedAt: new Date().toISOString() };
  saveState();
}

loadState();

// ── DAG dependencies ──────────────────────────────────────────────────────────

const deps = {};  // { "repo#issueId": [depIssueId, ...] }

function registerDeps(repo, issueId, depIds) {
  deps[`${repo}#${issueId}`] = depIds.map(Number);
}

function areDepsResolved(repo, issueId) {
  const key = `${repo}#${issueId}`;
  const d = deps[key];
  if (!d || !d.length) return true;
  return d.every(depId => {
    const depPipeline = getPipeline(repo, depId);
    return depPipeline && depPipeline.status === 'done';
  });
}

// ── Read rules.yaml from repo ─────────────────────────────────────────────────

async function readRulesYaml(repo) {
  const provider = getProvider(repo);
  if (!provider) return null;
  try {
    const content = await provider.getFileContent(repo, '.coderclaw/rules.yaml');
    if (!content) return null;
    // Simple YAML parsing for our specific format
    const gates = [];
    const gatesMatch = content.match(/gates:\s*\[([^\]]+)\]/);
    if (gatesMatch) {
      gatesMatch[1].split(',').forEach(g => {
        const t = g.trim().replace(/['"]/g, '');
        if (SPECIALISTS.includes(t)) gates.push(t);
      });
    }
    const requireAll = !/require_all:\s*false/.test(content);
    const maxRetries = (content.match(/max_retries:\s*(\d+)/) || [])[1];
    const retryUpgrade = !/retry_upgrade:\s*false/.test(content);
    return {
      gates: gates.length ? gates : ['fullstack'],
      requireAll,
      maxRetries: maxRetries ? parseInt(maxRetries) : MAX_RETRIES,
      retryUpgrade,
    };
  } catch {
    return null;
  }
}

// ── CPU analysis for specialist routing ───────────────────────────────────────

async function cpuAnalyzeIssue(issueTitle, issueBody) {
  return new Promise((resolve) => {
    const prompt = `You are a task router. Given this issue, determine which specialist gates are needed.
Available specialists: ${SPECIALISTS.join(', ')}

Issue: "${issueTitle}"
${issueBody ? `Description: "${issueBody.slice(0, 500)}"` : ''}

Reply with ONLY a JSON array of specialist names needed, e.g. ["fullstack","qa","doc"]. Most important first.`;

    const payload = JSON.stringify({
      model: 'qwen3.5:0.8b', prompt, stream: false, keep_alive: 0,
      options: { num_gpu: 0, num_predict: 100, temperature: 0 },
    });

    const url = new URL(OLLAMA_CPU_URL);
    const req = http.request({
      method: 'POST', hostname: url.hostname, port: url.port || 11434,
      path: '/api/generate',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const resp = JSON.parse(d).response || '';
          const match = resp.match(/\[.*\]/);
          if (match) {
            const arr = JSON.parse(match[0]).filter(r => SPECIALISTS.includes(r));
            resolve(arr.length ? arr : ['fullstack']);
          } else resolve(['fullstack']);
        } catch { resolve(['fullstack']); }
      });
    });
    req.on('error', () => resolve(['fullstack']));
    req.setTimeout(15000, () => { req.destroy(); resolve(['fullstack']); });
    req.write(payload); req.end();
  });
}

// ── Spawn a worker container ──────────────────────────────────────────────────

function spawnWorker(repo, issueId, role, branch, opts = {}) {
  const provider = getProvider(repo);
  if (!provider) throw new Error(`No provider for ${repo}`);

  const envVars = [
    `REPO=${repo}`,
    `ISSUE_ID=${issueId}`,
    `ROLE=${role}`,
    `PARENT_BRANCH=${branch}`,
    `OLLAMA_MODEL=${opts.model || process.env.OLLAMA_MODEL || 'qwen3.5:9b'}`,
    `OLLAMA_BASE_URL=${process.env.OLLAMA_BASE_URL || 'http://ollama:11434'}`,
    `OLLAMA_CPU_URL=${OLLAMA_CPU_URL}`,
    `SCHEDULER_URL=${SCHEDULER_URL}`,
    `SLOT_ID=${opts.slotId || ''}`,
    `GIT_PROVIDER_1=${process.env.GIT_PROVIDER_1 || 'forgejo'}`,
    `GIT_PROVIDER_1_URL=${process.env.GIT_PROVIDER_1_URL || ''}`,
    `GIT_PROVIDER_1_TOKEN=${process.env.GIT_PROVIDER_1_TOKEN || process.env.FORGEJO_TOKEN || ''}`,
    `GIT_PROVIDER_2=${process.env.GIT_PROVIDER_2 || ''}`,
    `GIT_PROVIDER_2_APP_ID=${process.env.GIT_PROVIDER_2_APP_ID || ''}`,
    `GIT_PROVIDER_2_PRIVATE_KEY_B64=${process.env.GIT_PROVIDER_2_PRIVATE_KEY_B64 || ''}`,
    `GIT_PROVIDER_2_INSTALLATION_ID=${process.env.GIT_PROVIDER_2_INSTALLATION_ID || ''}`,
    `FORGEJO_TOKEN=${process.env.FORGEJO_TOKEN || ''}`,
    `FORGEJO_URL=${process.env.GIT_PROVIDER_1_URL || 'http://host-gateway:3000'}`,
    `AGENT_GIT_LOGIN=${AGENT_LOGIN}`,
    `PROJECT_DATA_DIR=/projects`,
    `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
  ];

  const envFlags = envVars.map(e => `-e "${e}"`).join(' ');

  // Workers need access to: Ollama (backend), mcp-docs/devdocs/searxng/browserless (mcp-net),
  // git provider (proxy-internal-net or direct), and project data volume
  const networks = [
    '--network backend',
    '--network mcp-net',
    '--network proxy-internal-net',
  ].join(' ');

  const volumes = [
    '-v project_data:/projects',
  ].join(' ');

  const cmd = `docker run --rm -d --name worker-${role}-${issueId}-${Date.now()} ${networks} ${volumes} ${envFlags} ${WORKER_IMAGE}`;

  try {
    const containerId = execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim();
    log(`Worker spawned: ${role} for ${repo}#${issueId} branch=${branch} container=${containerId.slice(0, 12)}`);
    return containerId;
  } catch (e) {
    throw new Error(`Failed to spawn worker: ${e.message.slice(0, 200)}`);
  }
}

// ── Pipeline execution ────────────────────────────────────────────────────────

async function startPipeline(repo, issueId, opts = {}) {
  const provider = getProvider(repo);
  if (!provider) throw new Error(`No provider for ${repo}`);

  // Check DAG dependencies
  if (!areDepsResolved(repo, issueId)) {
    log(`Pipeline ${repo}#${issueId}: dependencies not resolved, queuing`);
    setPipeline(repo, issueId, { status: 'waiting_deps', gates: [], currentGate: -1 });
    return;
  }

  // Read issue
  const issue = await provider.getIssue(repo, issueId);
  const issueTitle = issue.title || '';
  const issueBody  = issue.body  || '';

  // Determine gates
  let gates;
  const rules = await readRulesYaml(repo);
  if (opts.role) {
    gates = [opts.role];  // Forced single gate
  } else if (rules) {
    gates = rules.gates;
  } else {
    // CPU analysis fallback
    gates = await cpuAnalyzeIssue(issueTitle, issueBody);
  }

  // Create branch name
  const slug = issueTitle.toLowerCase()
    .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
  const branch = `feat/${issueId}-${slug}`;

  // Check if branch exists (resume flow)
  let branchExists = false;
  try {
    const branches = await provider.listBranches(repo);
    branchExists = branches.some(b => (b.name || b) === branch);
  } catch {}

  if (!branchExists) {
    try {
      await provider.createBranch(repo, branch, rules?.targetBranch || 'main');
    } catch (e) {
      log(`Branch creation failed: ${e.message} — worker will create it via git`, 'WARN');
    }
  }

  // Initialize pipeline state
  const pipeline = {
    status: 'running',
    repo, issueId, branch,
    gates,
    currentGate: 0,
    retries: {},
    prNumber: null,
    stopped: false,
    maxRetries: rules?.maxRetries || MAX_RETRIES,
    retryUpgrade: rules?.retryUpgrade ?? RETRY_UPGRADE,
  };
  setPipeline(repo, issueId, pipeline);

  log(`Pipeline started: ${repo}#${issueId} gates=[${gates.join(',')}] branch=${branch}`);
  audit('pipeline_start', { repo, issueId, gates, branch });

  // Comment on issue
  await provider.addComment(repo, issueId,
    `🚀 Pipeline started\n\nBranch: \`${branch}\`\nGates: ${gates.map(g => `\`${g}\``).join(' → ')}`
  ).catch(() => {});

  // Start first gate
  await runNextGate(repo, issueId);
}

async function runNextGate(repo, issueId) {
  const pipeline = getPipeline(repo, issueId);
  if (!pipeline || pipeline.stopped) return;

  if (pipeline.currentGate >= pipeline.gates.length) {
    // All gates passed → create or update PR
    await finalizePR(repo, issueId);
    return;
  }

  const gate = pipeline.gates[pipeline.currentGate];
  log(`Gate ${pipeline.currentGate + 1}/${pipeline.gates.length}: ${gate} for ${repo}#${issueId}`);

  try {
    const containerId = spawnWorker(repo, issueId, gate, pipeline.branch);
    setPipeline(repo, issueId, {
      ...pipeline,
      activeWorker: { role: gate, containerId: containerId.slice(0, 12), startedAt: new Date().toISOString() },
    });
    audit('gate_start', { repo, issueId, gate, containerId: containerId.slice(0, 12) });
  } catch (e) {
    log(`Gate ${gate} spawn failed: ${e.message}`, 'WARN');
    await handleGateFail(repo, issueId, gate, e.message);
  }
}

async function handleGateComplete(repo, issueId, role, result, summary) {
  const pipeline = getPipeline(repo, issueId);
  if (!pipeline) return;

  audit('gate_complete', { repo, issueId, role, result, summary: summary?.slice(0, 200) });

  if (result === 'done' || result === 'pass') {
    // Advance to next gate
    setPipeline(repo, issueId, {
      ...pipeline,
      currentGate: pipeline.currentGate + 1,
      activeWorker: null,
    });
    log(`Gate ${role} passed for ${repo}#${issueId}`);
    await runNextGate(repo, issueId);

  } else if (result === 'fail') {
    await handleGateFail(repo, issueId, role, summary);

  } else if (result === 'refine') {
    // Note the refinement and continue
    setPipeline(repo, issueId, {
      ...pipeline,
      currentGate: pipeline.currentGate + 1,
      activeWorker: null,
    });
    log(`Gate ${role} refined for ${repo}#${issueId}: ${summary?.slice(0, 100)}`);
    await runNextGate(repo, issueId);
  }
}

async function handleGateFail(repo, issueId, role, reason) {
  const pipeline = getPipeline(repo, issueId);
  if (!pipeline) return;

  const retryKey = `${role}_${pipeline.currentGate}`;
  const retries  = (pipeline.retries[retryKey] || 0) + 1;
  pipeline.retries[retryKey] = retries;

  if (retries <= pipeline.maxRetries) {
    log(`Gate ${role} failed (${retries}/${pipeline.maxRetries}), retrying...`);
    setPipeline(repo, issueId, { ...pipeline, activeWorker: null });

    // Model upgrade on retry if configured
    const opts = {};
    if (pipeline.retryUpgrade && retries >= 2) {
      opts.model = process.env.MODEL_COMPLEX || 'qwen3.5:27b-q3_k_m';
    }

    try {
      const containerId = spawnWorker(repo, issueId, role, pipeline.branch, opts);
      setPipeline(repo, issueId, {
        ...pipeline,
        activeWorker: { role, containerId: containerId.slice(0, 12), startedAt: new Date().toISOString(), retry: retries },
      });
    } catch (e) {
      log(`Retry spawn failed: ${e.message}`, 'WARN');
    }
  } else {
    // Escalate to human
    log(`Gate ${role} failed ${retries}x — escalating to human`);
    setPipeline(repo, issueId, { ...pipeline, status: 'needs_human', activeWorker: null });

    const provider = getProvider(repo);
    if (provider) {
      await provider.addComment(repo, issueId,
        `⚠️ Gate \`${role}\` failed after ${retries} attempts.\n\nReason: ${reason?.slice(0, 500) || 'unknown'}\n\nUse \`/retry\` to restart or resolve manually.`
      ).catch(() => {});
      await provider.setLabel(repo, issueId, 'needs-human').catch(() => {});
    }
    audit('escalate_human', { repo, issueId, role, retries, reason: reason?.slice(0, 200) });
  }
}

// ── Finalize PR ───────────────────────────────────────────────────────────────

async function finalizePR(repo, issueId) {
  const pipeline = getPipeline(repo, issueId);
  if (!pipeline) return;

  const provider = getProvider(repo);
  if (!provider) return;

  const issue = await provider.getIssue(repo, issueId);
  const target = pipeline.gitFlowTarget || 'main';

  if (pipeline.prNumber) {
    // PR already exists — just comment that all gates passed
    await provider.addComment(repo, pipeline.prNumber,
      `✅ All gates passed: ${pipeline.gates.map(g => `\`${g}\``).join(' → ')}\n\nReady for review.`
    ).catch(() => {});
  } else {
    // Create PR
    const result = await provider.createPR(repo, {
      title: `${issue.title}`,
      body: `Closes #${issueId}\n\n## Pipeline\n${pipeline.gates.map(g => `- ✅ \`${g}\``).join('\n')}\n\n---\n*Automated by ClawDevWorker*`,
      head: pipeline.branch,
      base: target,
    });
    const prNumber = result.data?.number;
    if (prNumber) {
      setPipeline(repo, issueId, { ...pipeline, status: 'review', prNumber });
      log(`PR #${prNumber} created for ${repo}#${issueId}`);
      audit('pr_created', { repo, issueId, prNumber, branch: pipeline.branch });
    }
  }

  setPipeline(repo, issueId, { ...pipeline, status: 'review' });
}

// ── Determine which gates to re-run from a PR comment ─────────────────────────

async function determineGatesFromComment(commentBody, pipeline) {
  // If comment mentions a specific specialist, re-run that gate
  for (const specialist of SPECIALISTS) {
    if (commentBody.toLowerCase().includes(specialist)) {
      return pipeline.gates.filter(g => g === specialist);
    }
  }
  // Default: re-run all gates that touch code (skip doc/marketing)
  const codeGates = pipeline.gates.filter(g =>
    !['doc', 'marketing', 'design', 'product', 'bizdev'].includes(g)
  );
  return codeGates.length ? codeGates : pipeline.gates;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(resolve => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });
}

function readRawBody(req) {
  return new Promise(resolve => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => resolve(d));
  });
}

const server = http.createServer(async (req, res) => {

  // ── Webhook ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/webhook') {
    const rawBody = await readRawBody(req);
    let body;
    try { body = JSON.parse(rawBody); } catch { body = {}; }

    let provider = null;
    if (gitProviders.size > 0) {
      const { detectProvider } = require('/opt/git-provider/index.js');
      const info = detectProvider(req, gitProviders);
      if (info) {
        provider = info.provider;
        const sig = req.headers['x-hub-signature-256'] || req.headers['x-gitea-signature'] || '';
        if (sig && !provider.verifyWebhook(rawBody, sig)) {
          res.writeHead(403); res.end('Invalid signature'); return;
        }
      }
    }

    let event;
    if (provider) {
      event = provider.parseWebhook(req.headers, body);
    } else {
      const gitEvent = req.headers['x-gitea-event'] || req.headers['x-forgejo-event'] || req.headers['x-github-event'] || '';
      event = {
        type:    gitEvent === 'issues' && body.action === 'assigned' ? 'issue.assigned' : `${gitEvent}.${body.action}`,
        repo:    body.repository?.full_name,
        issue:   body.issue ? { id: body.issue.number, title: body.issue.title, body: body.issue.body || '',
                   labels: (body.issue.labels||[]).map(l=>l.name), assignee: body.issue.assignee?.login } : null,
        pr:      body.pull_request ? { id: body.pull_request.number, title: body.pull_request.title,
                   body: body.pull_request.body || '', labels: (body.pull_request.labels||[]).map(l=>l.name) } : null,
        comment: body.comment ? { body: body.comment.body, author: body.comment?.user?.login } : null,
        issueId: body.issue?.number,
      };
    }

    log(`Webhook: ${event.type} repo=${event.repo}`);

    // ── Issue assigned → start pipeline ──────────────────────────────────────
    if (event.type === 'issue.assigned' && event.issue?.assignee === AGENT_LOGIN && event.repo) {
      const existing = getPipeline(event.repo, event.issue.id);
      if (!existing || existing.status === 'done' || existing.status === 'needs_human') {
        startPipeline(event.repo, event.issue.id)
          .catch(e => {
            log(`Pipeline error: ${e.message}`, 'WARN');
            if (provider) provider.addComment(event.repo, event.issue.id,
              `⚠️ Pipeline start error: ${e.message}`).catch(() => {});
          });
      }
    }

    // ── Comment on issue → conversation before work ──────────────────────────
    if (event.type === 'comment' && event.repo && event.issueId) {
      const comment = event.comment?.body?.trim() || '';
      const author  = event.comment?.author || '';

      // Ignore agent's own comments
      if (author === AGENT_LOGIN) { res.writeHead(200); res.end('ok'); return; }

      // /stop → freeze pipeline
      if (comment === '/stop') {
        const pipeline = getPipeline(event.repo, event.issueId);
        if (pipeline) {
          setPipeline(event.repo, event.issueId, { ...pipeline, stopped: true, status: 'stopped' });
          log(`Pipeline stopped: ${event.repo}#${event.issueId}`);
          if (provider) provider.addComment(event.repo, event.issueId,
            `⏸️ Pipeline stopped. Comment when ready to resume.`).catch(() => {});
        }
      }

      // /retry → restart pipeline
      else if (comment === '/retry') {
        if (provider) provider.removeLabel(event.repo, event.issueId, 'needs-human').catch(() => {});
        startPipeline(event.repo, event.issueId)
          .catch(e => {
            if (provider) provider.addComment(event.repo, event.issueId,
              `⚠️ Retry failed: ${e.message}`).catch(() => {});
          });
      }

      // Natural conversation on issue/PR → check if pipeline should resume or re-trigger
      else {
        const pipeline = getPipeline(event.repo, event.issueId);
        if (pipeline) {
          // If stopped, human comment = implicit go
          if (pipeline.stopped && comment !== '/stop') {
            setPipeline(event.repo, event.issueId, { ...pipeline, stopped: false });
            log(`Pipeline resumed via comment: ${event.repo}#${event.issueId}`);
            startPipeline(event.repo, event.issueId)
              .catch(e => log(`Resume error: ${e.message}`, 'WARN'));
          }
          // If in review (PR submitted), human comment = re-trigger gates
          else if (pipeline.status === 'review' && pipeline.prNumber) {
            const gates = await determineGatesFromComment(comment, pipeline);
            log(`Re-triggering gates [${gates.join(',')}] from PR comment on ${event.repo}#${event.issueId}`);
            setPipeline(event.repo, event.issueId, {
              ...pipeline,
              status: 'running',
              gates,
              currentGate: 0,
              retries: {},
            });
            await runNextGate(event.repo, event.issueId);
          }
          // If done (merged), human comment = resume on same branch
          else if (pipeline.status === 'done') {
            log(`Post-merge resume: ${event.repo}#${event.issueId}`);
            setPipeline(event.repo, event.issueId, {
              ...pipeline,
              status: 'running',
              currentGate: 0,
              retries: {},
            });
            await runNextGate(event.repo, event.issueId);
          }
        }
      }
    }

    // ── PR merged → mark pipeline done ───────────────────────────────────────
    if (event.type === 'pr.closed' && event.pr && event.repo) {
      const issueMatch = (event.pr.body || '').match(/Closes\s+#(\d+)/i);
      if (issueMatch) {
        const issueId = parseInt(issueMatch[1]);
        const pipeline = getPipeline(event.repo, issueId);
        if (pipeline) {
          setPipeline(event.repo, issueId, { ...pipeline, status: 'done' });
          log(`Pipeline done (PR merged): ${event.repo}#${issueId}`);
          audit('pipeline_done', { repo: event.repo, issueId, prNumber: event.pr.id });
        }
      }
    }

    res.writeHead(200); res.end('ok');
    return;
  }

  // ── POST /gate-complete — called by workers when done ──────────────────────
  if (req.method === 'POST' && req.url === '/gate-complete') {
    const body = await readBody(req);
    const { repo, issueId, role, result, summary } = body;
    if (repo && issueId && role && result) {
      handleGateComplete(repo, issueId, role, result, summary)
        .catch(e => log(`Gate complete error: ${e.message}`, 'WARN'));
    }
    res.writeHead(200); res.end('ok');
    return;
  }

  // ── POST /deps ─────────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/deps') {
    const body = await readBody(req);
    const { repo, issueId, deps: depIds } = body;
    if (!repo || !issueId || !Array.isArray(depIds)) {
      res.writeHead(400); res.end('repo, issueId, deps[] required'); return;
    }
    registerDeps(repo, issueId, depIds);
    log(`DAG: #${issueId} on ${repo} → depends on [${depIds.join(', ')}]`);
    audit('deps_registered', { repo, issueId, deps: depIds });
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── POST /scheduler-event ──────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/scheduler-event') {
    const body = await readBody(req);
    log(`Scheduler event: ${body.event} taskId=${body.taskId}`);
    res.writeHead(200); res.end('ok');
    return;
  }

  // ── GET /status ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pipelines, providers: gitProviders.size }));
    return;
  }

  // ── Healthcheck ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, providers: gitProviders.size, activePipelines: Object.keys(pipelines).length }));
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(ORCHESTRATOR_PORT, '0.0.0.0', () => {
  log(`Orchestrator v3 started :${ORCHESTRATOR_PORT} (${gitProviders.size} providers, ${Object.keys(pipelines).length} active pipelines)`);
});
