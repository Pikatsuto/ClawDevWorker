/**
 * orchestrator/index.ts — Pipeline orchestrator v3
 *
 * Single-PR pipeline: all gates run sequentially on the same feature branch.
 *
 * Flow:
 *   1. Issue assigned → read rules.yaml → determine gates
 *   2. Create feature branch, run gates sequentially (each gate = one worker)
 *   3. Each worker commits on the shared branch, exits when done
 *   4. After all gates pass → open PR
 *   5. Human reviews → comments trigger re-run of relevant gates
 *   6. /stop → freeze pipeline, /retry → restart
 *
 * Webhook events:
 *   POST /webhook, /deps, /gate-complete, /scheduler-event
 *   GET  /health, /status
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { loadProviders, detectProvider, getProviderForRepo } from '#shared/git-provider/index.js';
import type { GitProvider } from '#shared/git-provider/types.js';

// ── Config ──────────────────────────────────────────────────────────────────

const SCHEDULER_URL = process.env.SCHEDULER_URL ?? 'http://localhost:7070';
const OLLAMA_CPU_URL = process.env.OLLAMA_CPU_URL ?? 'http://ollama-cpu:11434';
const ORCHESTRATOR_PORT = parseInt(process.env.ORCHESTRATOR_PORT ?? '9001');
const WORKER_IMAGE = process.env.WORKER_IMAGE ?? 'ghcr.io/pikatsuto/cdw-worker:latest';
const AGENT_LOGIN = process.env.AGENT_GIT_LOGIN ?? 'agent';
const STATE_DIR = process.env.STATE_DIR ?? join(process.env.HOME ?? '/root', '.openclaw/orchestrator');
const STATE_FILE = join(STATE_DIR, 'pipelines.json');
const AUDIT_FILE = join(STATE_DIR, 'audit.log');
const MAX_RETRIES = parseInt(process.env.GATE_MAX_RETRIES ?? '3');
const RETRY_UPGRADE = process.env.GATE_RETRY_UPGRADE !== 'false';

const SPECIALISTS = [
  'architect', 'frontend', 'backend', 'fullstack', 'devops',
  'security', 'qa', 'doc', 'marketing', 'design', 'product', 'bizdev',
] as const;

// ── Types ───────────────────────────────────────────────────────────────────

interface Pipeline {
  status: string;
  repo: string;
  issueId: number;
  branch: string;
  gates: string[];
  currentGate: number;
  retries: Record<string, number>;
  prNumber: number | null;
  stopped: boolean;
  maxRetries: number;
  retryUpgrade: boolean;
  specialistModels: Record<string, { model: string; fallback?: string | null }>;
  gitFlowTarget: string;
  activeWorker?: { role: string; containerId: string; startedAt: string; retry?: number } | null | undefined;
  updatedAt?: string | undefined;
  pausedAt?: string | null | undefined;
}

interface RulesYaml {
  gates: string[];
  requireAll: boolean;
  maxRetries: number;
  retryUpgrade: boolean;
  targetBranch: string;
  specialistModels: Record<string, { model: string; fallback?: string | null }>;
  specialistTriggers: Record<string, { triggers: string[] }>;
}

// ── Logging ─────────────────────────────────────────────────────────────────

const log = (msg: string, level = 'INFO') =>
  console.log(`[orchestrator] ${new Date().toISOString()} [${level}] ${msg}`);

const audit = (action: string, data: Record<string, unknown>) => {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, `${new Date().toISOString()} ${action} ${JSON.stringify(data)}\n`);
  } catch { /* silent */ }
};

// ── Git providers ───────────────────────────────────────────────────────────

let gitProviders: Map<string, GitProvider>;
try {
  gitProviders = loadProviders();
  log(`Git providers loaded: ${gitProviders.size}`);
} catch (e) {
  log(`Git provider error: ${(e as Error).message}`, 'WARN');
  gitProviders = new Map();
}

const getProvider = (repo: string) => getProviderForRepo(repo, gitProviders);

// ── Pipeline state ──────────────────────────────────────────────────────────

let pipelines: Record<string, Pipeline> = {};

const loadState = () => {
  try {
    if (existsSync(STATE_FILE)) {
      pipelines = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, Pipeline>;
    }
  } catch { /* silent */ }
};

const saveState = () => {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(pipelines, null, 2));
  } catch { /* silent */ }
};

const getPipeline = (repo: string, issueId: number | string): Pipeline | null => {
  const key = `${repo}#${issueId}`;
  return pipelines[key] ?? null;
};

const setPipeline = (repo: string, issueId: number | string, data: Partial<Pipeline>) => {
  const key = `${repo}#${issueId}`;
  pipelines[key] = { ...pipelines[key]!, ...data, updatedAt: new Date().toISOString() } as Pipeline;
  saveState();
};

loadState();

// ── DAG dependencies ────────────────────────────────────────────────────────

const depsMap: Record<string, number[]> = {};

const registerDeps = (repo: string, issueId: number | string, depIds: (string | number)[]) => {
  depsMap[`${repo}#${issueId}`] = depIds.map(Number);
};

const areDepsResolved = (repo: string, issueId: number | string): boolean => {
  const key = `${repo}#${issueId}`;
  const d = depsMap[key];
  if (!d?.length) return true;
  return d.every(depId => {
    const depPipeline = getPipeline(repo, depId);
    return depPipeline?.status === 'done';
  });
};

// ── Read rules.yaml from repo ───────────────────────────────────────────────

const readRulesYaml = async (repo: string): Promise<RulesYaml | null> => {
  const providerInfo = getProvider(repo);
  if (!providerInfo) return null;
  try {
    const content = await providerInfo.provider.getFileContent(repo, '.coderclaw/rules.yaml');
    if (!content) return null;

    const gates: string[] = [];
    const gatesMatch = content.match(/gates:\s*\[([^\]]+)\]/);
    if (gatesMatch) {
      gatesMatch[1]!.split(',').forEach(g => {
        const t = g.trim().replace(/['"]/g, '');
        if ((SPECIALISTS as readonly string[]).includes(t)) gates.push(t);
      });
    }

    const requireAll = !/require_all:\s*false/.test(content);
    const maxRetriesMatch = content.match(/max_retries:\s*(\d+)/);
    const retryUpgrade = !/retry_upgrade:\s*false/.test(content);
    const targetMatch = content.match(/target_branch:\s*(\S+)/);
    const targetBranch = targetMatch ? targetMatch[1]!.replace(/['"]/g, '') : 'main';

    const specialistModels: Record<string, { model: string; fallback?: string | null }> = {};
    const specialistTriggers: Record<string, { triggers: string[] }> = {};

    const specSection = content.split(/^specialists:\s*$/m)[1] ?? '';
    const specBlocks = specSection.split(/\n  (\w+):\s*\n/);
    for (let i = 1; i < specBlocks.length; i += 2) {
      const name = specBlocks[i]!;
      const block = specBlocks[i + 1] ?? '';
      if (!(SPECIALISTS as readonly string[]).includes(name)) continue;

      const modelMatch = block.match(/model:\s*(\S+)/);
      const fallbackMatch = block.match(/fallback:\s*(\S+)/);
      if (modelMatch) {
        specialistModels[name] = {
          model: modelMatch[1]!.replace(/['"]/g, ''),
          fallback: fallbackMatch ? fallbackMatch[1]!.replace(/['"]/g, '') : null,
        };
      }

      const triggersMatch = block.match(/triggers:\s*\[([^\]]+)\]/);
      if (triggersMatch) {
        specialistTriggers[name] = {
          triggers: triggersMatch[1]!.split(',').map(t => t.trim().replace(/['"]/g, '')),
        };
      }
    }

    return {
      gates: gates.length ? gates : ['fullstack'],
      requireAll,
      maxRetries: maxRetriesMatch ? parseInt(maxRetriesMatch[1]!) : MAX_RETRIES,
      retryUpgrade,
      targetBranch,
      specialistModels,
      specialistTriggers,
    };
  } catch { return null; }
};

// ── Specialist routing ──────────────────────────────────────────────────────

const matchTriggers = (issueText: string, specialistTriggers: Record<string, { triggers: string[] }>): string[] => {
  const text = issueText.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [role, config] of Object.entries(specialistTriggers)) {
    let score = 0;
    for (const trigger of config.triggers) {
      if (text.includes(trigger.toLowerCase())) score++;
    }
    if (score > 0) scores[role] = score;
  }

  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([role]) => role);
};

const cpuDisambiguate = (issueTitle: string, issueBody: string, candidates: string[]): Promise<string[] | null> =>
  new Promise(resolve => {
    const prompt = `You are a task router. Given this issue and these candidate specialists, pick the ones actually needed.

Candidates: ${candidates.join(', ')}

Issue: "${issueTitle}"
${issueBody ? `Description: "${issueBody.slice(0, 500)}"` : ''}

Reply with ONLY a JSON array from the candidates, e.g. ["fullstack","qa"]. Order by importance.`;

    const payload = JSON.stringify({
      model: 'qwen3.5:0.8b', prompt, stream: false, keep_alive: 0,
      options: { num_gpu: 0, num_predict: 100, temperature: 0 },
    });

    const url = new URL(OLLAMA_CPU_URL);
    const req = httpRequest({
      method: 'POST', hostname: url.hostname, port: url.port ? parseInt(url.port) : 11434,
      path: '/api/generate',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() },
    }, res => {
      let d = '';
      res.on('data', (c: string) => d += c);
      res.on('end', () => {
        try {
          const resp = (JSON.parse(d) as Record<string, unknown>).response as string ?? '';
          const match = resp.match(/\[.*\]/);
          if (match) {
            const arr = (JSON.parse(match[0]) as string[]).filter(r => candidates.includes(r));
            resolve(arr.length ? arr : null);
          } else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });

const routeIssue = async (repo: string, issueId: number, issue: Record<string, unknown>, rules: RulesYaml | null): Promise<string[] | null> => {
  const issueText = `${issue.title} ${issue.body ?? ''}`;
  const labels = (issue.labels as string[]) ?? [];
  const pipelineGates = rules?.gates ?? ['fullstack'];

  const labelGates = labels
    .filter(l => l.startsWith('gate:'))
    .map(l => l.replace('gate:', ''))
    .filter(r => (SPECIALISTS as readonly string[]).includes(r));

  if (labelGates.length > 0) {
    log(`Routing ${repo}#${issueId}: label override -> [${labelGates.join(',')}]`);
    return labelGates;
  }

  const specialistTriggers = rules?.specialistTriggers ?? {};
  const triggerMatched = matchTriggers(issueText, specialistTriggers);
  const relevantGates = triggerMatched.filter(r => pipelineGates.includes(r));

  if (relevantGates.length > 0) {
    if (relevantGates.length > 3) {
      log(`Routing ${repo}#${issueId}: ${relevantGates.length} triggers matched, asking CPU`);
      const cpuResult = await cpuDisambiguate(issue.title as string, issue.body as string, relevantGates);
      if (cpuResult) {
        log(`Routing ${repo}#${issueId}: CPU narrowed -> [${cpuResult.join(',')}]`);
        return cpuResult;
      }
    }
    log(`Routing ${repo}#${issueId}: trigger match -> [${relevantGates.join(',')}]`);
    return relevantGates;
  }

  log(`Routing ${repo}#${issueId}: no trigger match, full CPU analysis`);
  const cpuResult = await cpuDisambiguate(issue.title as string, issue.body as string, pipelineGates);
  if (cpuResult) {
    log(`Routing ${repo}#${issueId}: CPU analysis -> [${cpuResult.join(',')}]`);
    return cpuResult;
  }

  log(`Routing ${repo}#${issueId}: no confidence — will ask human`);
  return null;
};

// ── Preload model for next gate ─────────────────────────────────────────────

const preloadModel = async (modelId: string) => {
  try {
    const data = JSON.stringify({ modelId });
    const url = new URL(`${SCHEDULER_URL}/preload`);
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        hostname: url.hostname, port: url.port, path: '/preload', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length.toString() },
      }, res => { let b = ''; res.on('data', (c: string) => b += c); res.on('end', () => { log(`Preload ${modelId}: ${b}`); resolve(); }); });
      req.on('error', reject);
      req.end(data);
    });
  } catch (e) { log(`Preload ${modelId} failed: ${(e as Error).message}`, 'WARN'); }
};

// ── Spawn a worker container ────────────────────────────────────────────────

const spawnWorker = (repo: string, issueId: number | string, role: string, branch: string, opts: { model?: string | undefined; slotId?: string | undefined } = {}): string => {
  const providerInfo = getProvider(repo);
  if (!providerInfo) throw new Error(`No provider for ${repo}`);

  const envVars = [
    `REPO=${repo}`, `ISSUE_ID=${issueId}`, `ROLE=${role}`, `PARENT_BRANCH=${branch}`,
    `OLLAMA_MODEL=${opts.model ?? process.env.OLLAMA_MODEL ?? 'qwen3.5:9b'}`,
    `OLLAMA_BASE_URL=${process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434'}`,
    `OLLAMA_CPU_URL=${OLLAMA_CPU_URL}`, `SCHEDULER_URL=${SCHEDULER_URL}`,
    `SLOT_ID=${opts.slotId ?? ''}`,
    `GIT_PROVIDER_1=${process.env.GIT_PROVIDER_1 ?? 'forgejo'}`,
    `GIT_PROVIDER_1_URL=${process.env.GIT_PROVIDER_1_URL ?? ''}`,
    `GIT_PROVIDER_1_TOKEN=${process.env.GIT_PROVIDER_1_TOKEN ?? process.env.FORGEJO_TOKEN ?? ''}`,
    `GIT_PROVIDER_2=${process.env.GIT_PROVIDER_2 ?? ''}`,
    `GIT_PROVIDER_2_APP_ID=${process.env.GIT_PROVIDER_2_APP_ID ?? ''}`,
    `GIT_PROVIDER_2_PRIVATE_KEY_B64=${process.env.GIT_PROVIDER_2_PRIVATE_KEY_B64 ?? ''}`,
    `GIT_PROVIDER_2_INSTALLATION_ID=${process.env.GIT_PROVIDER_2_INSTALLATION_ID ?? ''}`,
    `FORGEJO_TOKEN=${process.env.FORGEJO_TOKEN ?? ''}`,
    `FORGEJO_URL=${process.env.GIT_PROVIDER_1_URL ?? 'http://host-gateway:3000'}`,
    `AGENT_GIT_LOGIN=${AGENT_LOGIN}`, `PROJECT_DATA_DIR=/projects`,
    `GITHUB_TOKEN=${process.env.GITHUB_TOKEN ?? ''}`,
    'HTTP_PROXY=http://cdw-squid:3128', 'HTTPS_PROXY=http://cdw-squid:3128',
    'NO_PROXY=localhost,127.0.0.1,ollama,ollama-cpu,devdocs,searxng,browserless,mcp-docs,cdw-squid',
  ];

  const envFlags = envVars.map(e => `-e "${e}"`).join(' ');
  const networks = '--network backend --network mcp-net --network proxy-internal-net';
  const volumes = '-v project_data:/projects';
  const cmd = `docker run --rm -d --name worker-${role}-${issueId}-${Date.now()} ${networks} ${volumes} ${envFlags} ${WORKER_IMAGE}`;

  try {
    const containerId = execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim();
    log(`Worker spawned: ${role} for ${repo}#${issueId} branch=${branch} container=${containerId.slice(0, 12)}`);
    return containerId;
  } catch (e) {
    throw new Error(`Failed to spawn worker: ${(e as Error).message.slice(0, 200)}`);
  }
};

// ── Pipeline execution ──────────────────────────────────────────────────────

const startPipeline = async (repo: string, issueId: number, opts: { role?: string } = {}) => {
  const providerInfo = getProvider(repo);
  if (!providerInfo) throw new Error(`No provider for ${repo}`);

  if (!areDepsResolved(repo, issueId)) {
    log(`Pipeline ${repo}#${issueId}: dependencies not resolved, queuing`);
    setPipeline(repo, issueId, { status: 'waiting_deps', gates: [], currentGate: -1 } as Partial<Pipeline>);
    return;
  }

  const issue = await providerInfo.provider.getIssue(repo, issueId);
  const rules = await readRulesYaml(repo);
  let gates: string[];

  if (opts.role) {
    gates = [opts.role];
  } else {
    const routed = await routeIssue(repo, issueId, issue, rules);
    if (routed === null) {
      await providerInfo.provider.addComment(repo, issueId,
        `🤔 I couldn't determine which specialists are needed for this issue.\n\n` +
        `Available gates: ${(rules?.gates ?? SPECIALISTS).map(g => `\`${g}\``).join(', ')}\n\n` +
        `Please add a label like \`gate:fullstack\` or \`gate:security\` to specify, then reassign me.`
      ).catch(() => { /* silent */ });
      await providerInfo.provider.setLabel(repo, issueId, 'needs-routing').catch(() => { /* silent */ });
      setPipeline(repo, issueId, { status: 'needs_routing', gates: [], currentGate: -1 } as Partial<Pipeline>);
      audit('needs_routing', { repo, issueId });
      return;
    }
    gates = routed;
  }

  const issueTitle = (issue.title as string) ?? '';
  const slug = issueTitle.toLowerCase()
    .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
  const branch = `feat/${issueId}-${slug}`;

  let branchExists = false;
  try {
    const branches = await providerInfo.provider.listBranches(repo);
    branchExists = branches.some(b => ((b as Record<string, unknown>).name ?? b) === branch);
  } catch { /* silent */ }

  if (!branchExists) {
    try {
      await providerInfo.provider.createBranch(repo, branch, rules?.targetBranch ?? 'main');
    } catch (e) {
      log(`Branch creation failed: ${(e as Error).message} — worker will create it via git`, 'WARN');
    }
  }

  const pipeline: Pipeline = {
    status: 'running', repo, issueId, branch, gates, currentGate: 0,
    retries: {}, prNumber: null, stopped: false,
    maxRetries: rules?.maxRetries ?? MAX_RETRIES,
    retryUpgrade: rules?.retryUpgrade ?? RETRY_UPGRADE,
    specialistModels: rules?.specialistModels ?? {},
    gitFlowTarget: rules?.targetBranch ?? 'main',
  };
  setPipeline(repo, issueId, pipeline);

  log(`Pipeline started: ${repo}#${issueId} gates=[${gates.join(',')}] branch=${branch}`);
  audit('pipeline_start', { repo, issueId, gates, branch });

  await providerInfo.provider.addComment(repo, issueId,
    `🚀 Pipeline started\n\nBranch: \`${branch}\`\nGates: ${gates.map(g => `\`${g}\``).join(' → ')}`
  ).catch(() => { /* silent */ });

  await runNextGate(repo, issueId);
};

const runNextGate = async (repo: string, issueId: number | string) => {
  const pipeline = getPipeline(repo, issueId);
  if (!pipeline?.gates || pipeline.stopped) return;

  if (pipeline.currentGate >= pipeline.gates.length) {
    await finalizePR(repo, issueId);
    return;
  }

  const gate = pipeline.gates[pipeline.currentGate]!;
  log(`Gate ${pipeline.currentGate + 1}/${pipeline.gates.length}: ${gate} for ${repo}#${issueId}`);

  const specConfig = pipeline.specialistModels?.[gate];
  const envModel = process.env[`MODEL_${gate.toUpperCase()}`];
  const gateModel = envModel ?? specConfig?.model;

  try {
    const containerId = spawnWorker(repo, issueId, gate, pipeline.branch, { model: gateModel });
    setPipeline(repo, issueId, {
      ...pipeline,
      activeWorker: { role: gate, containerId: containerId.slice(0, 12), startedAt: new Date().toISOString() },
    });
    audit('gate_start', { repo, issueId, gate, containerId: containerId.slice(0, 12) });

    const nextIdx = pipeline.currentGate + 1;
    if (nextIdx < pipeline.gates.length) {
      const nextGate = pipeline.gates[nextIdx]!;
      const nextSpec = pipeline.specialistModels?.[nextGate];
      const nextEnv = process.env[`MODEL_${nextGate.toUpperCase()}`];
      const nextModel = nextEnv ?? nextSpec?.model ?? process.env.OLLAMA_MODEL ?? 'qwen3.5:9b';
      preloadModel(nextModel).catch(() => { /* silent */ });
    }
  } catch (e) {
    log(`Gate ${gate} spawn failed: ${(e as Error).message}`, 'WARN');
    await handleGateFail(repo, issueId, gate, (e as Error).message);
  }
};

const handleGateComplete = async (repo: string, issueId: number | string, role: string, result: string, summary?: string) => {
  const pipeline = getPipeline(repo, issueId);
  if (!pipeline) return;

  audit('gate_complete', { repo, issueId, role, result, summary: summary?.slice(0, 200) });

  if (result === 'done' || result === 'pass') {
    setPipeline(repo, issueId, { ...pipeline, currentGate: pipeline.currentGate + 1, activeWorker: null });
    log(`Gate ${role} passed for ${repo}#${issueId}`);
    await runNextGate(repo, issueId);
  } else if (result === 'fail') {
    await handleGateFail(repo, issueId, role, summary);
  } else if (result === 'refine') {
    setPipeline(repo, issueId, { ...pipeline, currentGate: pipeline.currentGate + 1, activeWorker: null });
    log(`Gate ${role} refined for ${repo}#${issueId}: ${summary?.slice(0, 100)}`);
    await runNextGate(repo, issueId);
  }
};

const handleGateFail = async (repo: string, issueId: number | string, role: string, reason?: string) => {
  const pipeline = getPipeline(repo, issueId);
  if (!pipeline) return;

  const retryKey = `${role}_${pipeline.currentGate}`;
  const retries = (pipeline.retries[retryKey] ?? 0) + 1;
  pipeline.retries[retryKey] = retries;

  if (retries <= pipeline.maxRetries) {
    log(`Gate ${role} failed (${retries}/${pipeline.maxRetries}), retrying...`);
    setPipeline(repo, issueId, { ...pipeline, activeWorker: null });

    const opts: { model?: string } = {};
    if (pipeline.retryUpgrade && retries >= 2) {
      opts.model = process.env.MODEL_COMPLEX ?? 'qwen3.5:27b-q3_k_m';
    }

    try {
      const containerId = spawnWorker(repo, issueId, role, pipeline.branch, opts);
      setPipeline(repo, issueId, {
        ...pipeline,
        activeWorker: { role, containerId: containerId.slice(0, 12), startedAt: new Date().toISOString(), retry: retries },
      });
    } catch (e) {
      log(`Retry spawn failed: ${(e as Error).message}`, 'WARN');
    }
  } else {
    log(`Gate ${role} failed ${retries}x — escalating to human`);
    setPipeline(repo, issueId, { ...pipeline, status: 'needs_human', activeWorker: null });

    const providerInfo = getProvider(repo);
    if (providerInfo) {
      await providerInfo.provider.addComment(repo, Number(issueId),
        `⚠️ Gate \`${role}\` failed after ${retries} attempts.\n\nReason: ${reason?.slice(0, 500) ?? 'unknown'}\n\nUse \`/retry\` to restart or resolve manually.`
      ).catch(() => { /* silent */ });
      await providerInfo.provider.setLabel(repo, Number(issueId), 'needs-human').catch(() => { /* silent */ });
    }
    audit('escalate_human', { repo, issueId, role, retries, reason: reason?.slice(0, 200) });
  }
};

// ── Finalize PR ─────────────────────────────────────────────────────────────

const finalizePR = async (repo: string, issueId: number | string) => {
  const pipeline = getPipeline(repo, issueId);
  if (!pipeline) return;

  const providerInfo = getProvider(repo);
  if (!providerInfo) return;

  const target = pipeline.gitFlowTarget ?? 'main';

  if (pipeline.prNumber) {
    await providerInfo.provider.addComment(repo, pipeline.prNumber,
      `All gates passed: ${pipeline.gates.map(g => `\`${g}\``).join(' -> ')}\n\nReady for review.`
    ).catch(() => { /* silent */ });
  } else {
    const issue = await providerInfo.provider.getIssue(repo, Number(issueId));
    const result = await providerInfo.provider.createPR(repo, {
      title: (issue.title as string) ?? '',
      body: `Closes #${issueId}\n\n## Pipeline\n${pipeline.gates.map(g => `- \`${g}\``).join('\n')}\n\n---\n*Automated by ClawDevWorker*`,
      head: pipeline.branch,
      base: target,
    });
    const prNumber = (result.data as Record<string, unknown>)?.number as number | undefined;
    if (prNumber) {
      setPipeline(repo, issueId, { ...pipeline, status: 'review', prNumber });
      log(`PR #${prNumber} created for ${repo}#${issueId}`);
      audit('pr_created', { repo, issueId, prNumber, branch: pipeline.branch });
    }
  }

  setPipeline(repo, issueId, { ...pipeline, status: 'review' });
};

// ── Determine which gates to re-run from PR comment ─────────────────────────

const determineGatesFromComment = async (commentBody: string, pipeline: Pipeline): Promise<string[]> => {
  for (const specialist of SPECIALISTS) {
    if (commentBody.toLowerCase().includes(specialist)) {
      return pipeline.gates.filter(g => g === specialist);
    }
  }
  const codeGates = pipeline.gates.filter(g =>
    !['doc', 'marketing', 'design', 'product', 'bizdev'].includes(g),
  );
  return codeGates.length ? codeGates : pipeline.gates;
};

// ── HTTP Server ─────────────────────────────────────────────────────────────

const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise(resolve => {
    let d = '';
    req.on('data', (c: string) => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d) as Record<string, unknown>); } catch { resolve({}); } });
  });

const readRawBody = (req: IncomingMessage): Promise<string> =>
  new Promise(resolve => {
    let d = '';
    req.on('data', (c: string) => d += c);
    req.on('end', () => resolve(d));
  });

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url?.split('?')[0] ?? '';

  // ── Webhook ───────────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/webhook') {
    const rawBody = await readRawBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { body = {}; }

    let webhookProvider: GitProvider | null = null;
    if (gitProviders.size > 0) {
      const info = detectProvider(req, gitProviders);
      if (info) {
        webhookProvider = info.provider;
        const sig = (req.headers['x-hub-signature-256'] ?? req.headers['x-gitea-signature'] ?? '') as string;
        if (sig && !webhookProvider.verifyWebhook(rawBody, sig)) {
          res.writeHead(403); res.end('Invalid signature'); return;
        }
      }
    }

    let event: Record<string, unknown>;
    if (webhookProvider) {
      event = webhookProvider.parseWebhook(req.headers, body) as unknown as Record<string, unknown>;
    } else {
      const gitEvent = (req.headers['x-gitea-event'] ?? req.headers['x-forgejo-event'] ?? req.headers['x-github-event'] ?? '') as string;
      const issue = body.issue as Record<string, unknown> | undefined;
      const pr = body.pull_request as Record<string, unknown> | undefined;
      const comment = body.comment as Record<string, unknown> | undefined;
      event = {
        type: gitEvent === 'issues' && body.action === 'assigned' ? 'issue.assigned' : `${gitEvent}.${body.action}`,
        repo: (body.repository as Record<string, unknown>)?.full_name,
        issue: issue ? {
          id: issue.number, title: issue.title, body: issue.body ?? '',
          labels: ((issue.labels as Array<Record<string, unknown>>) ?? []).map(l => l.name as string),
          assignee: (issue.assignee as Record<string, unknown>)?.login,
        } : null,
        pr: pr ? { id: pr.number, title: pr.title, body: pr.body ?? '', labels: ((pr.labels as Array<Record<string, unknown>>) ?? []).map(l => l.name as string) } : null,
        comment: comment ? { body: (comment.body as string), author: (comment.user as Record<string, unknown>)?.login as string } : null,
        issueId: issue?.number,
      };
    }

    log(`Webhook: ${event.type} repo=${event.repo}`);

    if (event.type === 'issue.assigned') {
      const issueData = event.issue as Record<string, unknown>;
      if (issueData?.assignee === AGENT_LOGIN && event.repo) {
        const existing = getPipeline(event.repo as string, issueData.id as number);
        if (!existing || existing.status === 'done' || existing.status === 'needs_human') {
          startPipeline(event.repo as string, issueData.id as number)
            .catch(e => {
              log(`Pipeline error: ${(e as Error).message}`, 'WARN');
              if (webhookProvider) webhookProvider.addComment(event.repo as string, issueData.id as number,
                `Pipeline start error: ${(e as Error).message}`).catch(() => { /* silent */ });
            });
        }
      }
    }

    if (event.type === 'comment' && event.repo && event.issueId) {
      const commentData = event.comment as Record<string, unknown>;
      const commentText = ((commentData?.body as string) ?? '').trim();
      const author = (commentData?.author as string) ?? '';

      if (author === AGENT_LOGIN) { res.writeHead(200); res.end('ok'); return; }

      if (commentText === '/stop') {
        const pipeline = getPipeline(event.repo as string, event.issueId as number);
        if (pipeline) {
          setPipeline(event.repo as string, event.issueId as number, { ...pipeline, stopped: true, status: 'stopped' });
          log(`Pipeline stopped: ${event.repo}#${event.issueId}`);
          if (webhookProvider) webhookProvider.addComment(event.repo as string, event.issueId as number,
            '⏸️ Pipeline stopped. Comment when ready to resume.').catch(() => { /* silent */ });
        }
      } else if (commentText === '/retry') {
        if (webhookProvider) webhookProvider.removeLabel(event.repo as string, event.issueId as number, 'needs-human').catch(() => { /* silent */ });
        startPipeline(event.repo as string, event.issueId as number)
          .catch(e => {
            if (webhookProvider) webhookProvider.addComment(event.repo as string, event.issueId as number,
              `Retry failed: ${(e as Error).message}`).catch(() => { /* silent */ });
          });
      } else {
        const pipeline = getPipeline(event.repo as string, event.issueId as number);
        if (pipeline) {
          if (pipeline.stopped && commentText !== '/stop') {
            setPipeline(event.repo as string, event.issueId as number, { ...pipeline, stopped: false });
            log(`Pipeline resumed via comment: ${event.repo}#${event.issueId}`);
            startPipeline(event.repo as string, event.issueId as number)
              .catch(e => log(`Resume error: ${(e as Error).message}`, 'WARN'));
          } else if (pipeline.status === 'review' && pipeline.prNumber) {
            const gates = await determineGatesFromComment(commentText, pipeline);
            log(`Re-triggering gates [${gates.join(',')}] from PR comment on ${event.repo}#${event.issueId}`);
            setPipeline(event.repo as string, event.issueId as number, { ...pipeline, status: 'running', gates, currentGate: 0, retries: {} });
            await runNextGate(event.repo as string, event.issueId as number);
          } else if (pipeline.status === 'done') {
            log(`Post-merge resume: ${event.repo}#${event.issueId}`);
            setPipeline(event.repo as string, event.issueId as number, { ...pipeline, status: 'running', currentGate: 0, retries: {} });
            await runNextGate(event.repo as string, event.issueId as number);
          }
        }
      }
    }

    if (event.type === 'pr.closed' && event.pr && event.repo) {
      const prData = event.pr as Record<string, unknown>;
      const issueMatch = ((prData.body as string) ?? '').match(/Closes\s+#(\d+)/i);
      if (issueMatch) {
        const closedIssueId = parseInt(issueMatch[1]!);
        const pipeline = getPipeline(event.repo as string, closedIssueId);
        if (pipeline) {
          setPipeline(event.repo as string, closedIssueId, { ...pipeline, status: 'done' });
          log(`Pipeline done (PR merged): ${event.repo}#${closedIssueId}`);
          audit('pipeline_done', { repo: event.repo, issueId: closedIssueId, prNumber: prData.id });
        }
      }
    }

    res.writeHead(200); res.end('ok');
    return;
  }

  // ── POST /gate-complete ───────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/gate-complete') {
    const body = await readBody(req);
    if (body.repo && body.issueId && body.role && body.result) {
      handleGateComplete(body.repo as string, body.issueId as number, body.role as string, body.result as string, body.summary as string | undefined)
        .catch(e => log(`Gate complete error: ${(e as Error).message}`, 'WARN'));
    }
    res.writeHead(200); res.end('ok');
    return;
  }

  // ── POST /deps ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/deps') {
    const body = await readBody(req);
    const depIds = body.deps as string[] | undefined;
    if (!body.repo || !body.issueId || !Array.isArray(depIds)) {
      res.writeHead(400); res.end('repo, issueId, deps[] required'); return;
    }
    registerDeps(body.repo as string, body.issueId as number, depIds);
    log(`DAG: #${body.issueId} on ${body.repo} -> depends on [${depIds.join(', ')}]`);
    audit('deps_registered', { repo: body.repo, issueId: body.issueId, deps: depIds });
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── POST /scheduler-event ─────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/scheduler-event') {
    const body = await readBody(req);
    log(`Scheduler event: ${body.event} taskId=${body.taskId ?? 'n/a'}`);

    if (body.event === 'pause' && body.taskId) {
      for (const [key, pipeline] of Object.entries(pipelines)) {
        if (pipeline.activeWorker && pipeline.status === 'running') {
          const [pRepo, pIssueId] = key.split('#');
          setPipeline(pRepo!, pIssueId!, { ...pipeline, status: 'paused_gpu', pausedAt: new Date().toISOString() });
          log(`Pipeline ${key} paused (GPU scheduler — HUMAN_EXCLUSIVE)`);
          break;
        }
      }
    } else if (body.event === 'resume' && body.taskId) {
      for (const [key, pipeline] of Object.entries(pipelines)) {
        if (pipeline.status === 'paused_gpu') {
          const [pRepo, pIssueId] = key.split('#');
          setPipeline(pRepo!, pIssueId!, { ...pipeline, status: 'running', pausedAt: null });
          log(`Pipeline ${key} resumed (GPU available)`);
          break;
        }
      }
    }

    res.writeHead(200); res.end('ok');
    return;
  }

  // ── GET /status ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pipelines, providers: gitProviders.size }));
    return;
  }

  // ── Healthcheck ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, providers: gitProviders.size, activePipelines: Object.keys(pipelines).length }));
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(ORCHESTRATOR_PORT, '0.0.0.0', () => {
  log(`Orchestrator v3 started :${ORCHESTRATOR_PORT} (${gitProviders.size} providers, ${Object.keys(pipelines).length} active pipelines)`);
});
