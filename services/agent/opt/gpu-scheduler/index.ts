/**
 * gpu-scheduler v5 — cohabitation HUMAN_SHARED + HUMAN_EXCLUSIVE
 *
 * API:
 *   GET  /health
 *   GET  /status
 *   POST /enqueue, /release, /score, /preload
 *   POST /chat/request, /chat/fanout, /chat/release
 *   POST /chat/session/lock, /chat/session/score, /chat/session/confirm, /chat/session/release
 *   POST /human/heartbeat, /human/token-end, /human/active, /human/inactive
 *
 * Modes:
 *   AGENT_ACTIVE    → agents run freely
 *   HUMAN_SHARED    → human active, agents continue if VRAM allows
 *   HUMAN_EXCLUSIVE → human took all VRAM, agents paused
 */

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.SCHEDULER_PORT ?? '7070');
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://ollama:11434';
const OLLAMA_CPU_URL = process.env.OLLAMA_CPU_URL ?? 'http://ollama-cpu:11434';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:9001';
const HUMAN_IDLE_CHAT_MS = parseInt(process.env.HUMAN_IDLE_CHAT_MS ?? '900000');
const HUMAN_IDLE_AGENT_MS = parseInt(process.env.HUMAN_IDLE_AGENT_MS ?? '1800000');
const UPGRADE_THRESHOLD = parseInt(process.env.UPGRADE_THRESHOLD ?? '30');
const DOWNGRADE_THRESHOLD = parseInt(process.env.DOWNGRADE_THRESHOLD ?? '20');
const DOWNGRADE_STREAK_MAX = parseInt(process.env.DOWNGRADE_STREAK_MAX ?? '3');
const MIN_AGENT_VRAM = parseInt(process.env.MIN_AGENT_VRAM ?? '2');
const KEEPALIVE_MAX = parseInt(process.env.KEEPALIVE_MAX ?? '2');

// ── Types ───────────────────────────────────────────────────────────────────

interface ModelSpec {
  vram: number;
  quality: number;
  maxAgents: number;
  thinking: boolean;
  minScore: number;
}

interface GpuInfo {
  id: string;
  name: string;
  total: number;
  reserved: number;
}

interface LoadedModel {
  vram: number;
  gpus: string[];
  agentSlots: Map<string, string>;
  loadedAt: number;
  idleSince?: number | undefined;
}

interface QueueTask {
  taskId: string;
  repo: string;
  issueId?: string | undefined;
  role: string;
  score: number;
  title?: string | undefined;
  branch?: string | undefined;
  parentGroup?: string | undefined;
  addedAt: number;
}

interface ActiveSlot {
  taskId: string;
  modelId: string;
  role: string;
  score: number;
  repo: string;
  issueId?: string | undefined;
  branch?: string | undefined;
  colocGroup?: string | null | undefined;
  reservedAt: number;
}

interface ChatSlot {
  surface: string;
  modelId: string;
  requestId?: string | undefined;
  file?: string | undefined;
  allocatedAt: number;
}

interface SessionModel {
  modelId: string;
  ollamaUrl: string;
  fallback: boolean;
  surface: string;
  lockedAt: number;
  lowScoreStreak: number;
  pendingDowngrade: string | null;
  pendingUpgrade: string | null;
  lastScore: number;
}

interface ColocGroup {
  repo: string;
  branch?: string | undefined;
  taskIds: string[];
  modelId: string | null;
  slotIds: string[];
}

interface PlanAllocation {
  taskId: string;
  modelId: string;
  reuse: boolean;
  gpus?: string[] | undefined;
}

type SchedulerMode = 'AGENT_ACTIVE' | 'HUMAN_SHARED' | 'HUMAN_EXCLUSIVE' | 'HUMAN_ACTIVE';

// ── Model catalog ───────────────────────────────────────────────────────────

const M_COMPLEX = process.env.MODEL_COMPLEX ?? 'qwen3.5:27b-q3_k_m';
const M_STANDARD = process.env.MODEL_STANDARD ?? 'qwen3.5:9b';
const M_LIGHT = process.env.MODEL_LIGHT ?? 'qwen3.5:4b';
const M_TRIVIAL = process.env.MODEL_TRIVIAL ?? 'qwen3.5:2b';
const M_CPU = process.env.MODEL_CPU ?? 'qwen3.5:0.8b';
const M_MISTRAL = process.env.MODEL_WRITING ?? 'mistral:7b';

const VRAM_COMPLEX = parseInt(process.env.VRAM_COMPLEX ?? '14');
const VRAM_STANDARD = parseInt(process.env.VRAM_STANDARD ?? '5');
const VRAM_LIGHT = parseInt(process.env.VRAM_LIGHT ?? '3');
const VRAM_TRIVIAL = parseInt(process.env.VRAM_TRIVIAL ?? '2');

const MODELS: Record<string, ModelSpec> = {
  [M_COMPLEX]: { vram: VRAM_COMPLEX, quality: 10, maxAgents: 1, thinking: true, minScore: 70 },
  [M_STANDARD]: { vram: VRAM_STANDARD, quality: 7, maxAgents: 3, thinking: true, minScore: 30 },
  [M_LIGHT]: { vram: VRAM_LIGHT, quality: 4, maxAgents: 4, thinking: true, minScore: 10 },
  [M_TRIVIAL]: { vram: VRAM_TRIVIAL, quality: 2, maxAgents: 6, thinking: true, minScore: 0 },
  [M_CPU]: { vram: 0, quality: 1, maxAgents: 8, thinking: false, minScore: 0 },
};

// ── Per-role model preferences ──────────────────────────────────────────────

const SPECIALIST_ROLES = [
  'architect', 'frontend', 'backend', 'fullstack', 'devops', 'security', 'qa', 'doc',
  'marketing', 'design', 'product', 'bizdev',
] as const;

const ROLE_DEFAULTS: Record<string, string[]> = {
  architect: [M_COMPLEX, M_STANDARD, M_LIGHT],
  security: [M_COMPLEX, M_STANDARD, M_LIGHT],
  fullstack: [M_STANDARD, M_LIGHT, M_TRIVIAL],
  backend: [M_STANDARD, M_LIGHT, M_TRIVIAL],
  frontend: [M_STANDARD, M_LIGHT, M_TRIVIAL],
  devops: [M_STANDARD, M_LIGHT, M_TRIVIAL],
  qa: [M_STANDARD, M_LIGHT, M_TRIVIAL],
  doc: [M_MISTRAL, M_LIGHT, M_TRIVIAL],
  marketing: [M_MISTRAL, M_LIGHT, M_TRIVIAL],
  design: [M_MISTRAL, M_LIGHT, M_TRIVIAL],
  product: [M_MISTRAL, M_LIGHT, M_TRIVIAL],
  bizdev: [M_MISTRAL, M_LIGHT, M_TRIVIAL],
};

const MODEL_PREFS: Record<string, string[]> = {
  chat: [M_COMPLEX, M_STANDARD, M_LIGHT, M_TRIVIAL],
  audit: [M_STANDARD, M_LIGHT, M_TRIVIAL],
};

for (const role of SPECIALIST_ROLES) {
  const envModel = process.env[`MODEL_${role.toUpperCase()}`];
  if (envModel) {
    MODEL_PREFS[role] = [envModel, M_STANDARD, M_LIGHT, M_TRIVIAL];
  } else {
    MODEL_PREFS[role] = ROLE_DEFAULTS[role] ?? [M_STANDARD, M_LIGHT, M_TRIVIAL];
  }
}
MODEL_PREFS.dev = MODEL_PREFS.frontend!;

const MODEL_UPGRADE: Record<string, string | null> = {
  [M_TRIVIAL]: M_LIGHT, [M_LIGHT]: M_STANDARD, [M_STANDARD]: M_COMPLEX, [M_COMPLEX]: null,
};
const MODEL_DOWNGRADE: Record<string, string | null> = {
  [M_COMPLEX]: M_STANDARD, [M_STANDARD]: M_LIGHT, [M_LIGHT]: M_TRIVIAL, [M_TRIVIAL]: null,
};

// ── GPU state ───────────────────────────────────────────────────────────────

const GPUS: GpuInfo[] = [
  { id: 'gpu0', name: 'RTX 2080 Ti', total: 11, reserved: 0 },
  { id: 'gpu1', name: 'GTX 1660', total: 6, reserved: 0 },
];

const totalVram = () => GPUS.reduce((a, g) => a + g.total, 0);
const totalFree = () => GPUS.reduce((a, g) => a + g.total - g.reserved, 0);

const KW = {
  critical: ['security', 'auth', 'migration', 'database', 'architecture', 'refactor', 'refacto', 'system', 'deploy', 'infrastructure', 'performance', 'breaking', 'cve', 'vulnerability'],
  high: ['feature', 'api', 'integration', 'multi', 'async', 'concurrent', 'cache', 'algorithm', 'search', 'indexing'],
  medium: ['bug', 'fix', 'error', 'crash', 'regression', 'test', 'validation'],
  low: ['typo', 'css', 'style', 'rename', 'copy', 'wording', 'comment', 'doc', 'documentation', 'readme', 'indent', 'format', 'lint'],
} as const;

const state = {
  mode: 'AGENT_ACTIVE' as SchedulerMode,
  humanLastSeen: 0,
  humanIdleTimer: null as ReturnType<typeof setTimeout> | null,
  activeSurface: null as string | null,
  waitingForTokenEnd: false,
  pendingSurface: null as string | null,
  chatSlots: new Map<string, ChatSlot>(),
  loadedModels: new Map<string, LoadedModel>(),
  activeSlots: new Map<string, ActiveSlot>(),
  colocGroups: new Map<string, ColocGroup>(),
  queue: [] as QueueTask[],
  pausedTasks: new Map<string, ActiveSlot & { slotId: string; pausedAt: number }>(),
  sessionModels: new Map<string, SessionModel>(),
};

let slotCounter = 0;
let groupCounter = 0;

const log = (msg: string, lvl = 'INFO') =>
  console.log(`[gpu-scheduler] ${new Date().toISOString()} [${lvl}] ${msg}`);

// ── VRAM ────────────────────────────────────────────────────────────────────

const allocateVram = (vramNeeded: number): string[] | null => {
  const free = GPUS.map(g => ({ ...g, free: g.total - g.reserved }));
  for (const gpu of free.sort((a, b) => b.free - a.free)) {
    if (gpu.free >= vramNeeded) {
      GPUS.find(g => g.id === gpu.id)!.reserved += vramNeeded;
      return [gpu.id];
    }
  }
  if (free.reduce((a, g) => a + g.free, 0) >= vramNeeded) {
    let rem = vramNeeded;
    const allocated: string[] = [];
    for (const gpu of free.sort((a, b) => b.free - a.free)) {
      if (rem <= 0) break;
      const take = Math.min(gpu.free, rem);
      if (take > 0) {
        GPUS.find(g => g.id === gpu.id)!.reserved += take;
        allocated.push(gpu.id);
        rem -= take;
      }
    }
    return allocated;
  }
  return null;
};

const releaseVram = (gpuIds: string[], vramTotal: number) => {
  const perGpu = vramTotal / gpuIds.length;
  for (const id of gpuIds) {
    const gpu = GPUS.find(g => g.id === id);
    if (gpu) gpu.reserved = Math.max(0, gpu.reserved - perGpu);
  }
};

// ── Scoring ─────────────────────────────────────────────────────────────────

const computeScore = ({ title = '', body = '', role = 'dev', labels = [] as string[], estimatedFiles = 1 }) => {
  let score = 30;
  const text = `${title} ${body}`.toLowerCase();
  for (const kw of KW.critical) if (text.includes(kw)) score += 15;
  for (const kw of KW.high) if (text.includes(kw)) score += 8;
  for (const kw of KW.medium) if (text.includes(kw)) score += 4;
  for (const kw of KW.low) if (text.includes(kw)) score -= 10;
  if (role === 'qa') score -= 15;
  if (role === 'audit') score -= 10;
  if (body.length > 2000) score += 10; else if (body.length > 500) score += 5; else if (body.length < 100) score -= 5;
  if (estimatedFiles > 10) score += 15; else if (estimatedFiles > 5) score += 8; else if (estimatedFiles > 2) score += 4;
  if (labels.some(l => ['critical', 'security', 'priority:high'].includes(l.toLowerCase()))) score += 20;
  if (labels.some(l => ['good first issue', 'trivial', 'easy'].includes(l.toLowerCase()))) score -= 15;
  return Math.max(0, Math.min(100, score));
};

const computeChatScore = (messages: Array<{ role: string; content: string | Array<{ text?: string }> }> = []) => {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return 30;
  const content = typeof lastUser.content === 'string'
    ? lastUser.content
    : (lastUser.content ?? []).map(c => c.text ?? '').join(' ');
  let score = 20;
  const text = content.toLowerCase();
  if (content.length > 1000) score += 20; else if (content.length > 300) score += 10; else if (content.length < 50) score -= 10;
  for (const kw of KW.critical) if (text.includes(kw)) score += 12;
  for (const kw of KW.high) if (text.includes(kw)) score += 6;
  for (const kw of KW.medium) if (text.includes(kw)) score += 3;
  for (const kw of KW.low) if (text.includes(kw)) score -= 8;
  if ([/^(what is|how do|why)\b/i, /\?$/, /^(thanks|ok|yes|no)\b/i].some(p => p.test(content.trim()))) score -= 15;
  if (/\b(refactor|rewrite|implement|create|generate)\b/i.test(text)) score += 15;
  if (/\b(file|class|module|component)\b/i.test(text)) score += 8;
  return Math.max(0, Math.min(100, score));
};

// ── Ollama ──────────────────────────────────────────────────────────────────

const ollamaReq = (method: string, urlPath: string, body: object | null = null, baseUrl = OLLAMA_URL): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: url.hostname, port: url.port ?? 11434, path: url.pathname,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() } : {},
    };
    const req = httpRequest(opts, res => {
      let d = '';
      res.on('data', (c: string) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d) as Record<string, unknown>); } catch { resolve({ raw: d }); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const loadModel = async (modelId: string) => {
  if (state.loadedModels.has(modelId)) return;
  log(`Loading: ${modelId}`);
  try {
    await ollamaReq('POST', '/api/generate', { model: modelId, keep_alive: -1, prompt: '', options: { num_parallel: MODELS[modelId]?.maxAgents ?? 2 } });
    log(`${modelId} ready (max ${MODELS[modelId]?.maxAgents} agents)`);
  } catch (e) { log(`Error loading ${modelId}: ${(e as Error).message}`, 'WARN'); }
};

const unloadModel = async (modelId: string) => {
  try {
    await ollamaReq('POST', '/api/generate', { model: modelId, keep_alive: 0, prompt: '' });
    state.loadedModels.delete(modelId);
    log(`${modelId} unloaded`);
  } catch (e) { log(`Error unloading ${modelId}: ${(e as Error).message}`, 'WARN'); }
};

const evictLRU = async (neededVram: number): Promise<boolean> => {
  const idleModels = [...state.loadedModels.entries()]
    .filter(([, m]) => m.agentSlots.size === 0 && m.idleSince)
    .filter(([modelId]) => ![...state.sessionModels.values()].some(s => s.modelId === modelId))
    .sort((a, b) => a[1].idleSince! - b[1].idleSince!);

  let freed = 0;
  for (const [modelId, loaded] of idleModels) {
    if (totalFree() + freed >= neededVram) break;
    releaseVram(loaded.gpus, loaded.vram);
    await unloadModel(modelId);
    freed += loaded.vram;
    log(`Evicted idle model ${modelId} (LRU, freed ${loaded.vram}GB)`);
  }
  return totalFree() >= neededVram;
};

const enforceKeepAliveMax = async () => {
  const idleModels = [...state.loadedModels.entries()]
    .filter(([, m]) => m.agentSlots.size === 0 && m.idleSince)
    .filter(([modelId]) => ![...state.sessionModels.values()].some(s => s.modelId === modelId))
    .sort((a, b) => a[1].idleSince! - b[1].idleSince!);

  while (idleModels.length > KEEPALIVE_MAX) {
    const [modelId, loaded] = idleModels.shift()!;
    releaseVram(loaded.gpus, loaded.vram);
    await unloadModel(modelId);
    log(`Evicted idle model ${modelId} (exceeded KEEPALIVE_MAX=${KEEPALIVE_MAX})`);
  }
};

// ── Dispatch chat/vscode ────────────────────────────────────────────────────

const dispatchChatModel = async (score: number) => {
  const prefs = MODEL_PREFS.chat!;
  const idealId = prefs.find(m => MODELS[m]?.minScore !== undefined && MODELS[m]!.minScore <= score) ?? prefs[prefs.length - 1]!;
  const idealQ = MODELS[idealId]?.quality ?? 0;

  const candidates: Array<{ modelId: string; quality: number; reuse: boolean }> = [];
  for (const modelId of prefs) {
    const loaded = state.loadedModels.get(modelId);
    if (!loaded) continue;
    if (loaded.agentSlots.size < (MODELS[modelId]?.maxAgents ?? 1)) {
      candidates.push({ modelId, quality: MODELS[modelId]?.quality ?? 0, reuse: true });
    }
  }
  if (candidates.length > 0) {
    const best = candidates
      .filter(c => c.quality >= idealQ - 2)
      .sort((a, b) => b.quality - a.quality)[0]
      ?? candidates.sort((a, b) => b.quality - a.quality)[0]!;
    log(`Chat dispatch: reusing ${best.modelId} (score=${score})`);
    return { modelId: best.modelId, ollamaUrl: OLLAMA_URL, fallback: false, reuse: true };
  }

  const idealModel = MODELS[idealId];
  if (idealModel) {
    if (totalFree() >= idealModel.vram || await evictLRU(idealModel.vram)) {
      log(`Chat dispatch: loading ${idealId} (score=${score}, free=${totalFree()}GB)`);
      return { modelId: idealId, ollamaUrl: OLLAMA_URL, fallback: false, reuse: false };
    }
  }

  log(`Chat dispatch: fallback CPU (score=${score}, free=${totalFree()}GB)`, 'WARN');
  return { modelId: 'qwen3.5:0.8b', ollamaUrl: OLLAMA_CPU_URL, fallback: true, reuse: false };
};

// ── Session model lock ──────────────────────────────────────────────────────

const getOrCreateSession = async (sessionId: string, surface: string, messages: Array<{ role: string; content: string | Array<{ text?: string }> }>) => {
  const existing = state.sessionModels.get(sessionId);
  if (existing) return existing;

  const score = computeChatScore(messages);
  const dispatch = await dispatchChatModel(score);

  if (!dispatch.fallback && !dispatch.reuse) {
    const model = MODELS[dispatch.modelId];
    if (model) {
      const gpus = allocateVram(model.vram);
      if (gpus) {
        await loadModel(dispatch.modelId);
        if (!state.loadedModels.has(dispatch.modelId))
          state.loadedModels.set(dispatch.modelId, { vram: model.vram, gpus, agentSlots: new Map(), loadedAt: Date.now() });
      }
    }
  }

  const session: SessionModel = {
    modelId: dispatch.modelId,
    ollamaUrl: dispatch.ollamaUrl,
    fallback: dispatch.fallback,
    surface,
    lockedAt: Date.now(),
    lowScoreStreak: 0,
    pendingDowngrade: null,
    pendingUpgrade: null,
    lastScore: score,
  };

  state.sessionModels.set(sessionId, session);
  log(`Session ${sessionId} locked on ${dispatch.modelId} (score=${score} surface=${surface})`);
  return session;
};

const evaluateSessionMessage = async (sessionId: string, messages: Array<{ role: string; content: string | Array<{ text?: string }> }>) => {
  const session = state.sessionModels.get(sessionId);
  if (!session) return { action: 'no_session' };

  const score = computeChatScore(messages);
  const model = MODELS[session.modelId];
  const minScore = model?.minScore ?? 0;
  session.lastScore = score;

  if (score > minScore + UPGRADE_THRESHOLD) {
    session.lowScoreStreak = 0;
    const targetModel = MODEL_UPGRADE[session.modelId];
    if (!targetModel) return { action: 'ok', modelId: session.modelId, ollamaUrl: session.ollamaUrl };

    const targetVram = MODELS[targetModel]?.vram ?? 0;
    const currentVram = model?.vram ?? 0;
    const vramDelta = targetVram - currentVram;
    const hasFreeVram = totalFree() >= vramDelta;
    const reason = `Score ${score} exceeds current model threshold (${session.modelId}, minScore=${minScore}) by +${score - minScore - UPGRADE_THRESHOLD} points`;

    if (session.surface === 'agent') {
      if (state.mode !== 'HUMAN_EXCLUSIVE' && state.mode !== 'HUMAN_ACTIVE' && hasFreeVram) {
        await applySessionModelChange(sessionId, targetModel);
        log(`Session ${sessionId} silently upgraded -> ${targetModel} (score=${score})`);
        return { action: 'ok', modelId: targetModel, ollamaUrl: OLLAMA_URL, silent: true };
      }
      return { action: 'ok', modelId: session.modelId, ollamaUrl: session.ollamaUrl };
    }

    if (!session.pendingUpgrade) {
      session.pendingUpgrade = targetModel;
      const vramInfo = hasFreeVram
        ? `${vramDelta}GB additional available`
        : `missing ${vramDelta - totalFree()}GB — some agents will be paused`;
      return {
        action: 'upgrade', modelId: session.modelId, targetModel, ollamaUrl: session.ollamaUrl,
        vramDelta, hasFreeVram, reason,
        message: `This task deserves a more powerful model.\nSwitch to **${targetModel}** (${vramInfo}).\nReply \`/upgrade\` to confirm or continue with the current model.`,
      };
    }
    return { action: 'ok', modelId: session.modelId, ollamaUrl: session.ollamaUrl };
  }

  if (score < minScore - DOWNGRADE_THRESHOLD) {
    session.lowScoreStreak++;
    if (session.lowScoreStreak >= DOWNGRADE_STREAK_MAX) {
      session.lowScoreStreak = 0;
      const targetModel = MODEL_DOWNGRADE[session.modelId];
      if (!targetModel) return { action: 'ok', modelId: session.modelId, ollamaUrl: session.ollamaUrl };

      const vramFreed = (model?.vram ?? 0) - (MODELS[targetModel]?.vram ?? 0);

      if (session.surface === 'agent') {
        if (state.mode !== 'HUMAN_EXCLUSIVE' && state.mode !== 'HUMAN_ACTIVE') {
          await applySessionModelChange(sessionId, targetModel);
          log(`Session ${sessionId} silently downgraded -> ${targetModel} (streak=${DOWNGRADE_STREAK_MAX})`);
          return { action: 'ok', modelId: targetModel, ollamaUrl: OLLAMA_URL, silent: true };
        }
        return { action: 'ok', modelId: session.modelId, ollamaUrl: session.ollamaUrl };
      }

      if (!session.pendingDowngrade) {
        session.pendingDowngrade = targetModel;
        return {
          action: 'downgrade', modelId: session.modelId, targetModel, ollamaUrl: session.ollamaUrl, vramFreed,
          message: `The last ${DOWNGRADE_STREAK_MAX} messages don't require **${session.modelId}**.\nSwitching to **${targetModel}** would free **${vramFreed}GB** of VRAM for your agents.\nReply \`/downgrade\` to confirm or continue normally.`,
        };
      }
    }
    return { action: 'ok', modelId: session.modelId, ollamaUrl: session.ollamaUrl };
  }

  session.lowScoreStreak = 0;
  session.pendingUpgrade = null;
  return { action: 'ok', modelId: session.modelId, ollamaUrl: session.ollamaUrl };
};

const applySessionModelChange = async (sessionId: string, targetModelId: string): Promise<boolean> => {
  const session = state.sessionModels.get(sessionId);
  if (!session) return false;

  const oldModelId = session.modelId;
  const targetModel = MODELS[targetModelId];
  if (!targetModel) return false;

  const loaded = state.loadedModels.get(oldModelId);
  if (loaded) {
    for (const [k, v] of loaded.agentSlots) {
      if (v === sessionId) { loaded.agentSlots.delete(k); break; }
    }
    if (loaded.agentSlots.size === 0) {
      releaseVram(loaded.gpus, loaded.vram);
      await unloadModel(oldModelId);
    }
  }

  const gpus = allocateVram(targetModel.vram);
  if (gpus) {
    await loadModel(targetModelId);
    if (!state.loadedModels.has(targetModelId))
      state.loadedModels.set(targetModelId, { vram: targetModel.vram, gpus, agentSlots: new Map(), loadedAt: Date.now() });
  }

  session.modelId = targetModelId;
  session.ollamaUrl = OLLAMA_URL;
  session.fallback = false;
  session.pendingDowngrade = null;
  session.pendingUpgrade = null;
  session.lowScoreStreak = 0;
  log(`Session ${sessionId}: ${oldModelId} -> ${targetModelId}`);
  return true;
};

const releaseSession = async (sessionId: string) => {
  const session = state.sessionModels.get(sessionId);
  if (!session) return;

  const loaded = state.loadedModels.get(session.modelId);
  if (loaded) {
    for (const [k, v] of loaded.agentSlots) {
      if (v === sessionId) { loaded.agentSlots.delete(k); break; }
    }
    if (loaded.agentSlots.size === 0 && state.mode === 'AGENT_ACTIVE') {
      releaseVram(loaded.gpus, loaded.vram);
      await unloadModel(session.modelId);
    }
  }

  state.sessionModels.delete(sessionId);
  log(`Session ${sessionId} released (${session.modelId})`);
};

// ── CPU ambiguity check ─────────────────────────────────────────────────────

const AMBIGUITY_ZONE_LOW = 45;
const AMBIGUITY_ZONE_HIGH = 75;

const cpuAmbiguityCheck = async ({ title, body, role, score, queueLength, currentModel, degradedModel }: {
  title: string; body: string; role: string; score: number; queueLength: number; currentModel: string; degradedModel: string;
}): Promise<string | null> => {
  if (score <= AMBIGUITY_ZONE_LOW || score >= AMBIGUITY_ZONE_HIGH) return null;
  if (queueLength <= 1) return null;
  const currentQ = MODELS[currentModel]?.quality ?? 0;
  const degradedQ = MODELS[degradedModel]?.quality ?? 0;
  if (currentQ - degradedQ > 3) return null;

  const prompt = [
    `Issue: "${title}"`, body ? `Description: "${body.slice(0, 300)}"` : '',
    `Role: ${role} | Score: ${score}/100`,
    `Current model: ${currentModel} (q=${currentQ}/10) -> degraded: ${degradedModel} (q=${degradedQ}/10)`,
    `Queue: ${queueLength} tasks`,
    `Degrade to free an additional GPU slot? YES or NO.`,
  ].filter(Boolean).join('\n');

  try {
    const res = await ollamaReq('POST', '/api/generate', {
      model: 'qwen3.5:0.8b', prompt, stream: false, keep_alive: 0,
      options: { num_gpu: 0, num_predict: 5, temperature: 0 },
    }, OLLAMA_CPU_URL);
    const decision = ((res.response as string) ?? '').trim().toUpperCase().startsWith('YES') ? 'degrade' : 'keep';
    log(`CPU ambiguity -> ${decision}`);
    return decision;
  } catch (e) { log(`CPU ambiguity failed: ${(e as Error).message}`, 'WARN'); return null; }
};

// ── Plan queue ──────────────────────────────────────────────────────────────

const evalPlan = (plan: PlanAllocation[], queueSize: number): number => {
  if (!plan.length) return 0;
  const qualityNorm = plan.reduce((a, p) => a + (MODELS[p.modelId]?.quality ?? 0), 0) / (plan.length * 10);
  const parallelNorm = plan.length / Math.max(queueSize, 1);
  return qualityNorm * 0.7 + parallelNorm * 0.3;
};

const planQueue = (): PlanAllocation[] => {
  if (!state.queue.length) return [];

  const getPrefsForRole = (role: string): string[] => {
    const envKey = `MODEL_${role.toUpperCase()}`;
    const envModel = process.env[envKey];
    const base = MODEL_PREFS[role] ?? MODEL_PREFS.dev!;
    if (envModel && !base.includes(envModel)) {
      if (!MODELS[envModel]) {
        MODELS[envModel] = { vram: 5, quality: 7, maxAgents: 3, thinking: true, minScore: 0 };
        log(`MODEL_${role.toUpperCase()}=${envModel} loaded from .env (estimated vram 5GB)`);
      }
      return [envModel, ...base];
    }
    return base;
  };

  const sorted = [...state.queue].sort((a, b) => b.score - a.score);
  const queueSize = sorted.length;
  let bestPlan: PlanAllocation[] = [];
  let bestScore = -1;

  for (const qualityThreshold of [85, 70, 55, 40, 0]) {
    const simGpus = GPUS.map(g => ({ ...g }));
    const simLoaded = new Map([...state.loadedModels.entries()].map(([k, v]) => [k, { ...v, agentSlots: new Map(v.agentSlots) }]));
    const simFree = () => simGpus.reduce((a, g) => a + g.total - g.reserved, 0);
    const plan: PlanAllocation[] = [];

    for (const task of sorted) {
      const prefs = getPrefsForRole(task.role);
      let allocated = false;

      for (const modelId of prefs) {
        const loaded = simLoaded.get(modelId);
        if (!loaded) continue;
        const model = MODELS[modelId];
        if (!model || loaded.agentSlots.size >= model.maxAgents || model.minScore > task.score) continue;
        if (task.score > qualityThreshold) {
          if ((MODELS[prefs[0]!]?.quality ?? 10) - model.quality > 2) continue;
        }
        loaded.agentSlots.set(`sim-${plan.length}`, task.taskId);
        plan.push({ taskId: task.taskId, modelId, reuse: true });
        allocated = true;
        break;
      }
      if (allocated) continue;

      for (const modelId of prefs) {
        const model = MODELS[modelId];
        if (!model || model.minScore > task.score) continue;
        if (modelId !== prefs[0] && task.score > qualityThreshold) {
          if ((MODELS[prefs[0]!]?.quality ?? 10) - model.quality > 2) continue;
        }
        if (simFree() < model.vram) continue;
        let rem = model.vram;
        const gpus: string[] = [];
        for (const g of [...simGpus].sort((a, b) => (b.total - b.reserved) - (a.total - a.reserved))) {
          if (rem <= 0) break;
          const take = Math.min(g.total - g.reserved, rem);
          if (take > 0) { simGpus.find(sg => sg.id === g.id)!.reserved += take; gpus.push(g.id); rem -= take; }
        }
        simLoaded.set(modelId, { vram: model.vram, gpus, agentSlots: new Map([[`sim-${plan.length}`, task.taskId]]), loadedAt: Date.now() });
        plan.push({ taskId: task.taskId, modelId, reuse: false, gpus });
        allocated = true;
        break;
      }
    }

    const sc = evalPlan(plan, queueSize);
    if (sc > bestScore) { bestScore = sc; bestPlan = plan; }
  }

  if (bestPlan.length > 0) {
    const summary = [...new Set(bestPlan.map(p => p.modelId))]
      .map(m => `${m}(x${bestPlan.filter(p => p.modelId === m).length})`).join(', ');
    log(`Plan: ${bestPlan.length}/${queueSize} tasks | score=${bestScore.toFixed(3)} | ${summary}`);
  }
  return bestPlan;
};

// ── Co-localisation ─────────────────────────────────────────────────────────

const canColocate = (t1: QueueTask | ActiveSlot, t2: QueueTask | ActiveSlot): boolean => {
  if (t1.repo !== t2.repo) return false;
  if (t1.role === 'audit' && t2.role === 'audit') return true;
  if ('parentGroup' in t1 && 'parentGroup' in t2 && t1.parentGroup && t1.parentGroup === t2.parentGroup) return true;
  if (t1.branch && t1.branch === t2.branch) return true;
  return false;
};

const findOrCreateColocGroup = (task: QueueTask): string | null => {
  for (const [groupId, group] of state.colocGroups) {
    if (group.repo !== task.repo) continue;
    const anyTask = state.queue.find(t => group.taskIds.includes(t.taskId))
      ?? [...state.activeSlots.values()].find(s => group.taskIds.includes(s.taskId));
    if (anyTask && canColocate(task, anyTask)) return groupId;
  }
  for (const queued of state.queue) {
    if (queued.taskId === task.taskId) continue;
    if (canColocate(task, queued)) {
      const groupId = `group-${++groupCounter}`;
      state.colocGroups.set(groupId, { repo: task.repo, branch: task.branch ?? queued.branch, taskIds: [queued.taskId, task.taskId], modelId: null, slotIds: [] });
      log(`Coloc group ${groupId}: ${queued.taskId} + ${task.taskId}`);
      return groupId;
    }
  }
  return null;
};

// ── Notifications ───────────────────────────────────────────────────────────

const notify = (baseUrl: string, event: string, data: Record<string, unknown>) => {
  try {
    const body = JSON.stringify({ event, ...data });
    const url = new URL('/scheduler-event', baseUrl);
    const req = httpRequest({
      method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString() },
    });
    req.on('error', () => { /* silent */ });
    req.write(body);
    req.end();
  } catch { /* silent */ }
};

// ── Human priority ──────────────────────────────────────────────────────────

const agentFreeVram = () => Math.max(0, totalFree());

const pauseAgentsIfNeeded = async () => {
  const free = agentFreeVram();
  log(`HUMAN_SHARED — VRAM free=${free}GB MIN_AGENT=${MIN_AGENT_VRAM}GB`);

  if (free >= MIN_AGENT_VRAM) {
    log('Active agents maintained (VRAM sufficient)');
    return;
  }

  log('Insufficient VRAM for cohabitation -> HUMAN_EXCLUSIVE', 'WARN');
  state.mode = 'HUMAN_EXCLUSIVE';

  for (const [slotId, slot] of state.activeSlots) {
    state.pausedTasks.set(slot.taskId, { slotId, ...slot, pausedAt: Date.now() });
    notify(ORCHESTRATOR_URL, 'pause', { taskId: slot.taskId });
  }
  state.activeSlots.clear();

  for (const [modelId, loaded] of state.loadedModels) {
    const hasChatSlot = [...state.chatSlots.values()].some(s => s.modelId === modelId);
    if (!hasChatSlot) {
      releaseVram(loaded.gpus, loaded.vram);
      await unloadModel(modelId);
    }
  }
  for (const modelId of [...state.loadedModels.keys()]) {
    const hasChatSlot = [...state.chatSlots.values()].some(s => s.modelId === modelId);
    if (!hasChatSlot) state.loadedModels.delete(modelId);
  }
  log(`HUMAN_EXCLUSIVE — free=${totalFree()}GB`);
};

const tryResumeAgents = async () => {
  if (state.mode === 'AGENT_ACTIVE') return;
  if (!state.pausedTasks.size) return;

  const free = agentFreeVram();
  if (free < MIN_AGENT_VRAM) {
    log(`tryResumeAgents: VRAM ${free}GB < ${MIN_AGENT_VRAM}GB -> no resume`);
    return;
  }

  log(`VRAM ${free}GB available — attempting to resume paused agents`);
  if (state.mode === 'HUMAN_EXCLUSIVE' || state.mode === 'HUMAN_ACTIVE') state.mode = 'HUMAN_SHARED';

  for (const [taskId, ctx] of state.pausedTasks) {
    state.queue.push({
      taskId, repo: ctx.repo, issueId: ctx.issueId, role: ctx.role,
      score: ctx.score, branch: ctx.branch, parentGroup: ctx.colocGroup ?? undefined,
      addedAt: Date.now(),
    });
    notify(ORCHESTRATOR_URL, 'resume', { taskId });
    state.pausedTasks.delete(taskId);
  }
  await processQueue();
};

const resumeAgentsFull = async () => {
  if (state.mode === 'AGENT_ACTIVE') return;
  log(`AGENT_ACTIVE — human idle ${HUMAN_IDLE_CHAT_MS / 60000}min`);
  state.mode = 'AGENT_ACTIVE';
  state.activeSurface = null;

  for (const [taskId, ctx] of state.pausedTasks) {
    state.queue.unshift({
      taskId, repo: ctx.repo, issueId: ctx.issueId, role: ctx.role,
      score: ctx.score, branch: ctx.branch, parentGroup: ctx.colocGroup ?? undefined,
      addedAt: Date.now(),
    });
    notify(ORCHESTRATOR_URL, 'resume', { taskId });
  }
  state.pausedTasks.clear();
  await processQueue();
};

const scheduleIdleCheck = () => {
  if (state.humanIdleTimer) clearTimeout(state.humanIdleTimer);
  state.humanIdleTimer = setTimeout(async () => {
    if (Date.now() - state.humanLastSeen >= HUMAN_IDLE_CHAT_MS) {
      log(`Human idle ${HUMAN_IDLE_CHAT_MS / 60000}min -> AGENT_ACTIVE`);
      await resumeAgentsFull();
    }
  }, HUMAN_IDLE_CHAT_MS);
};

const handleHeartbeat = async (surface: string) => {
  state.humanLastSeen = Date.now();

  if (state.activeSurface && state.activeSurface !== surface) {
    if (state.waitingForTokenEnd) {
      state.pendingSurface = surface;
      return { ok: true, surface, preempting: true, waiting: true };
    }
    log(`Surface ${surface} preempts ${state.activeSurface} (waiting for token end)`, 'WARN');
    state.waitingForTokenEnd = true;
    state.pendingSurface = surface;
    return { ok: true, surface, preempting: true, waiting: true };
  }

  state.activeSurface = surface;

  if (state.mode === 'AGENT_ACTIVE') {
    state.mode = 'HUMAN_SHARED';
    log(`${surface} active -> HUMAN_SHARED`);
    await pauseAgentsIfNeeded();
  } else if (state.mode === 'HUMAN_EXCLUSIVE' || state.mode === 'HUMAN_ACTIVE') {
    await tryResumeAgents();
  }

  scheduleIdleCheck();
  const free = agentFreeVram();
  return { ok: true, surface, mode: state.mode, vramFree: free, agentsCanRun: free >= MIN_AGENT_VRAM };
};

const handleTokenEnd = () => {
  if (!state.waitingForTokenEnd || !state.pendingSurface) return false;
  const prev = state.activeSurface;
  state.activeSurface = state.pendingSurface;
  state.waitingForTokenEnd = false;
  state.pendingSurface = null;
  log(`Surface switch ${prev} -> ${state.activeSurface}`);
  scheduleIdleCheck();
  return true;
};

// ── processQueue ────────────────────────────────────────────────────────────

const processQueue = async () => {
  if (state.mode === 'HUMAN_EXCLUSIVE' || state.mode === 'HUMAN_ACTIVE') return;
  if (!state.queue.length) return;

  const maxVramForAgents = state.mode === 'HUMAN_SHARED' ? agentFreeVram() : Infinity;
  if (state.mode === 'HUMAN_SHARED' && maxVramForAgents < MIN_AGENT_VRAM) {
    log(`processQueue: HUMAN_SHARED VRAM ${maxVramForAgents}GB < ${MIN_AGENT_VRAM}GB -> pause`);
    return;
  }

  const plan = planQueue();
  if (!plan.length) return;

  for (const allocation of plan) {
    const taskIdx = state.queue.findIndex(t => t.taskId === allocation.taskId);
    if (taskIdx === -1) continue;
    const task = state.queue[taskIdx]!;

    try {
      let loaded = state.loadedModels.get(allocation.modelId);
      if (!allocation.reuse || !loaded) {
        if (loaded?.idleSince) delete loaded.idleSince;
        const model = MODELS[allocation.modelId]!;
        let gpus = allocateVram(model.vram);
        if (!gpus) { await evictLRU(model.vram); gpus = allocateVram(model.vram); }
        if (!gpus) { log(`Insufficient VRAM for ${allocation.modelId}`, 'WARN'); continue; }
        await loadModel(allocation.modelId);
        loaded = { vram: model.vram, gpus, agentSlots: new Map(), loadedAt: Date.now() };
        state.loadedModels.set(allocation.modelId, loaded);
      }

      const model = MODELS[allocation.modelId]!;
      if (loaded.agentSlots.size >= model.maxAgents) { log(`${allocation.modelId} saturated`, 'WARN'); continue; }
      if (loaded.idleSince) delete loaded.idleSince;

      const slotId = `slot-${++slotCounter}`;
      loaded.agentSlots.set(slotId, task.taskId);
      const colocGroupId = task.parentGroup ?? findOrCreateColocGroup(task);

      if (colocGroupId) {
        const g = state.colocGroups.get(colocGroupId);
        if (g) { g.slotIds.push(slotId); g.modelId = g.modelId ?? allocation.modelId; }
      }

      state.activeSlots.set(slotId, {
        taskId: task.taskId, modelId: allocation.modelId, role: task.role, score: task.score,
        repo: task.repo, issueId: task.issueId, branch: task.branch,
        colocGroup: colocGroupId, reservedAt: Date.now(),
      });
      state.queue.splice(taskIdx, 1);

      const used = loaded.agentSlots.size;
      log(`${slotId}: ${task.taskId} -> ${allocation.modelId} [score=${task.score} q=${model.quality} agents=${used}/${model.maxAgents} ${allocation.reuse ? 'reused' : 'new'} free=${totalFree()}GB${colocGroupId ? ` coloc=${colocGroupId}` : ''}]`);
      notify(ORCHESTRATOR_URL, 'slot-ready', { taskId: task.taskId, slotId, modelId: allocation.modelId, gpus: loaded.gpus, colocGroup: colocGroupId, agentIndex: used - 1 });
    } catch (e) { log(`Error allocating ${task.taskId}: ${(e as Error).message}`, 'WARN'); }
  }
  log(`VRAM: ${totalFree()}/${totalVram()}GB free | active=${state.activeSlots.size} | queue=${state.queue.length}`);
};

// ── HTTP server ─────────────────────────────────────────────────────────────

const jsonRes = (res: ServerResponse, code: number, data: unknown) => {
  const b = JSON.stringify(data, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(b);
};

const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise(r => {
    let d = '';
    req.on('data', (c: string) => d += c);
    req.on('end', () => { try { r(JSON.parse(d) as Record<string, unknown>); } catch { r({}); } });
  });

const server = createServer(async (req, res) => {
  const url = req.url?.split('?')[0] ?? '';

  if (req.method === 'GET' && url === '/health')
    return jsonRes(res, 200, { ok: true, mode: state.mode, activeSurface: state.activeSurface });

  if (req.method === 'GET' && url === '/status')
    return jsonRes(res, 200, {
      mode: state.mode, activeSurface: state.activeSurface, humanLastSeen: state.humanLastSeen,
      gpus: GPUS.map(g => ({ ...g, free: g.total - g.reserved, usedPct: Math.round(g.reserved / g.total * 100) })),
      totalFree: totalFree(), totalVram: totalVram(),
      loadedModels: [...state.loadedModels.entries()].map(([id, m]) => ({ modelId: id, vram: m.vram, gpus: m.gpus, agents: m.agentSlots.size, maxAgents: MODELS[id]?.maxAgents, quality: MODELS[id]?.quality, idle: m.idleSince ? Date.now() - m.idleSince : null })),
      activeSlots: [...state.activeSlots.entries()].map(([id, s]) => ({ slotId: id, ...s })),
      chatSlots: [...state.chatSlots.entries()].map(([id, s]) => ({ slotId: id, ...s })),
      colocGroups: [...state.colocGroups.entries()].map(([id, g]) => ({ groupId: id, ...g })),
      queue: state.queue.map(t => ({ taskId: t.taskId, score: t.score, role: t.role, repo: t.repo })),
      paused: [...state.pausedTasks.keys()],
      sessionModels: [...state.sessionModels.entries()].map(([id, s]) => ({
        sessionId: id, modelId: s.modelId, surface: s.surface,
        lockedAt: s.lockedAt, lowScoreStreak: s.lowScoreStreak, lastScore: s.lastScore,
        pendingUpgrade: s.pendingUpgrade, pendingDowngrade: s.pendingDowngrade,
      })),
    });

  if (req.method === 'POST' && url === '/chat/request') {
    const body = await readBody(req);
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const surface = (body.surface as string) ?? 'chat';
    const requestId = body.requestId as string | undefined;
    const score = computeChatScore(messages);
    const dispatch = await dispatchChatModel(score);
    let slotId: string | null = null;
    if (!dispatch.fallback) {
      if (!dispatch.reuse) {
        const model = MODELS[dispatch.modelId];
        if (model) {
          const gpus = allocateVram(model.vram);
          if (gpus) {
            await loadModel(dispatch.modelId);
            if (!state.loadedModels.has(dispatch.modelId))
              state.loadedModels.set(dispatch.modelId, { vram: model.vram, gpus, agentSlots: new Map(), loadedAt: Date.now() });
            else state.loadedModels.get(dispatch.modelId)!.gpus = gpus;
          }
        }
      }
      slotId = `chat-${++slotCounter}`;
      const loaded = state.loadedModels.get(dispatch.modelId);
      if (loaded) loaded.agentSlots.set(slotId, requestId ?? slotId);
      state.chatSlots.set(slotId, { surface, modelId: dispatch.modelId, requestId, allocatedAt: Date.now() });
    }
    log(`/chat/request surface=${surface} score=${score} model=${dispatch.modelId} fallback=${dispatch.fallback} slot=${slotId}`);
    return jsonRes(res, 200, { model: dispatch.modelId, ollamaUrl: dispatch.ollamaUrl, fallback: dispatch.fallback, slotId, score });
  }

  if (req.method === 'POST' && url === '/chat/fanout') {
    const body = await readBody(req);
    const subtasks = (body.subtasks ?? []) as Array<{ messages?: Array<{ role: string; content: string }>; requestId?: string; file?: string }>;
    const surface = (body.surface as string) ?? 'vscode';
    const results = await Promise.all(subtasks.map(async sub => {
      const score = computeChatScore(sub.messages ?? []);
      const dispatch = await dispatchChatModel(score);
      let slotId: string | null = null;
      if (!dispatch.fallback) {
        if (!dispatch.reuse) {
          const model = MODELS[dispatch.modelId];
          if (model) {
            const gpus = allocateVram(model.vram);
            if (gpus) {
              await loadModel(dispatch.modelId);
              if (!state.loadedModels.has(dispatch.modelId))
                state.loadedModels.set(dispatch.modelId, { vram: model.vram, gpus, agentSlots: new Map(), loadedAt: Date.now() });
            }
          }
        }
        slotId = `fanout-${++slotCounter}`;
        const loaded = state.loadedModels.get(dispatch.modelId);
        if (loaded) loaded.agentSlots.set(slotId, sub.requestId ?? slotId);
        state.chatSlots.set(slotId, { surface, modelId: dispatch.modelId, requestId: sub.requestId, file: sub.file, allocatedAt: Date.now() });
      }
      log(`Fan-out slot: file=${sub.file} score=${score} model=${dispatch.modelId} slot=${slotId}`);
      return { file: sub.file, requestId: sub.requestId, model: dispatch.modelId, ollamaUrl: dispatch.ollamaUrl, fallback: dispatch.fallback, slotId, score };
    }));
    return jsonRes(res, 200, { subtasks: results });
  }

  if (req.method === 'POST' && url === '/chat/release') {
    const { slotId } = await readBody(req) as { slotId: string };
    const slot = state.chatSlots.get(slotId);
    if (!slot) return jsonRes(res, 404, { error: 'unknown chatSlot' });
    const loaded = state.loadedModels.get(slot.modelId);
    if (loaded) {
      loaded.agentSlots.delete(slotId);
      if (loaded.agentSlots.size === 0 && state.mode === 'AGENT_ACTIVE') {
        releaseVram(loaded.gpus, loaded.vram);
        await unloadModel(slot.modelId);
      }
    }
    state.chatSlots.delete(slotId);
    log(`chatSlot ${slotId} released (${slot.modelId}) | free=${totalFree()}GB`);
    setImmediate(() => tryResumeAgents().catch(() => { /* silent */ }));
    return jsonRes(res, 200, { ok: true, totalFree: totalFree() });
  }

  if (req.method === 'POST' && url === '/chat/session/lock') {
    const body = await readBody(req);
    const sessionId = body.sessionId as string;
    const surface = (body.surface as string) ?? 'chat';
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    if (!sessionId) return jsonRes(res, 400, { error: 'sessionId required' });
    const session = await getOrCreateSession(sessionId, surface, messages);
    log(`/chat/session/lock ${sessionId} -> ${session.modelId} (surface=${surface})`);
    return jsonRes(res, 200, { sessionId, modelId: session.modelId, ollamaUrl: session.ollamaUrl, fallback: session.fallback, lockedAt: session.lockedAt });
  }

  if (req.method === 'POST' && url === '/chat/session/score') {
    const body = await readBody(req);
    const sessionId = body.sessionId as string;
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    if (!sessionId) return jsonRes(res, 400, { error: 'sessionId required' });
    if (!state.sessionModels.has(sessionId)) {
      const surface = (body.surface as string) ?? 'chat';
      await getOrCreateSession(sessionId, surface, messages);
    }
    const result = await evaluateSessionMessage(sessionId, messages);
    const session = state.sessionModels.get(sessionId);
    return jsonRes(res, 200, { ...result, lowScoreStreak: session?.lowScoreStreak ?? 0 });
  }

  if (req.method === 'POST' && url === '/chat/session/confirm') {
    const body = await readBody(req);
    const sessionId = body.sessionId as string;
    const direction = body.direction as string;
    if (!sessionId || !direction) return jsonRes(res, 400, { error: 'sessionId and direction required' });
    const session = state.sessionModels.get(sessionId);
    if (!session) return jsonRes(res, 404, { error: 'unknown session' });
    const targetModel = direction === 'upgrade' ? session.pendingUpgrade : session.pendingDowngrade;
    if (!targetModel) return jsonRes(res, 409, { error: 'no swap awaiting confirmation' });
    const ok = await applySessionModelChange(sessionId, targetModel);
    const updated = state.sessionModels.get(sessionId);
    log(`/chat/session/confirm ${sessionId} ${direction} -> ${targetModel} ok=${ok}`);
    return jsonRes(res, 200, { ok, modelId: updated?.modelId, ollamaUrl: updated?.ollamaUrl });
  }

  if (req.method === 'POST' && url === '/chat/session/release') {
    const { sessionId } = await readBody(req) as { sessionId: string };
    if (!sessionId) return jsonRes(res, 400, { error: 'sessionId required' });
    await releaseSession(sessionId);
    return jsonRes(res, 200, { ok: true, totalFree: totalFree() });
  }

  if (req.method === 'POST' && url === '/enqueue') {
    const body = await readBody(req);
    const { taskId, repo, issueId, title = '', labels = [], estimatedFiles = 1, parentGroup, branch, forceScore } = body as {
      taskId: string; repo: string; issueId?: string; title?: string; labels?: string[];
      estimatedFiles?: number; parentGroup?: string; branch?: string; forceScore?: number;
    };
    const role = (body.role as string) ?? 'dev';
    const issueBody = (body.issueBody as string) ?? '';
    if (!taskId || !repo) return jsonRes(res, 400, { error: 'taskId and repo required' });

    let score = forceScore !== undefined
      ? Math.max(0, Math.min(100, forceScore))
      : computeScore({ title, body: issueBody, role, labels, estimatedFiles });

    if (forceScore === undefined && state.queue.length > 0) {
      const prefs = MODEL_PREFS[role] ?? MODEL_PREFS.dev!;
      const dec = await cpuAmbiguityCheck({
        title, body: issueBody, role, score,
        queueLength: state.queue.length + 1,
        currentModel: prefs[0]!, degradedModel: prefs[1]!,
      });
      if (dec === 'degrade') score = Math.min(score, AMBIGUITY_ZONE_LOW - 1);
      if (dec === 'keep') score = Math.max(score, AMBIGUITY_ZONE_HIGH + 1);
    }

    const task: QueueTask = { taskId, repo, issueId, role, score, title, parentGroup, branch, addedAt: Date.now() };
    state.queue.push(task);
    log(`Enqueued ${taskId} (score=${score} role=${role} repo=${repo})`);

    if (state.mode === 'HUMAN_EXCLUSIVE' || state.mode === 'HUMAN_ACTIVE')
      return jsonRes(res, 202, { status: 'queued', reason: 'human_exclusive', score });

    await processQueue();
    const slot = [...state.activeSlots.values()].find(s => s.taskId === taskId);
    return slot
      ? jsonRes(res, 200, { status: 'started', ...slot })
      : jsonRes(res, 202, { status: 'queued', reason: 'vram_full', score });
  }

  if (req.method === 'POST' && url === '/release') {
    const { slotId } = await readBody(req) as { slotId: string };
    const slot = state.activeSlots.get(slotId);
    if (!slot) return jsonRes(res, 404, { error: 'unknown slot' });
    const loaded = state.loadedModels.get(slot.modelId);
    if (loaded) {
      loaded.agentSlots.delete(slotId);
      if (loaded.agentSlots.size === 0) {
        loaded.idleSince = Date.now();
        log(`${slot.modelId} idle (kept alive, free=${totalFree()}GB)`);
        await enforceKeepAliveMax();
      }
    }
    if (slot.colocGroup) {
      const g = state.colocGroups.get(slot.colocGroup);
      if (g) {
        g.slotIds = g.slotIds.filter(id => id !== slotId);
        if (!g.slotIds.length) state.colocGroups.delete(slot.colocGroup);
      }
    }
    state.activeSlots.delete(slotId);
    log(`${slotId} released (${slot.modelId}) | free=${totalFree()}GB`);
    if (state.mode === 'HUMAN_SHARED' || state.mode === 'HUMAN_EXCLUSIVE') {
      setImmediate(() => tryResumeAgents().catch(() => { /* silent */ }));
    } else {
      await processQueue();
    }
    return jsonRes(res, 200, { ok: true, totalFree: totalFree() });
  }

  if (req.method === 'POST' && url === '/preload') {
    const { modelId } = await readBody(req) as { modelId: string };
    if (!modelId || !MODELS[modelId]) return jsonRes(res, 400, { error: 'unknown model' });
    if (state.loadedModels.has(modelId)) return jsonRes(res, 200, { status: 'already_loaded' });
    const model = MODELS[modelId]!;
    let gpus = allocateVram(model.vram);
    if (!gpus) { await evictLRU(model.vram); gpus = allocateVram(model.vram); }
    if (!gpus) return jsonRes(res, 200, { status: 'no_vram', free: totalFree(), needed: model.vram });
    await loadModel(modelId);
    if (!state.loadedModels.has(modelId))
      state.loadedModels.set(modelId, { vram: model.vram, gpus, agentSlots: new Map(), loadedAt: Date.now(), idleSince: Date.now() });
    log(`Preloaded ${modelId} for next gate (free=${totalFree()}GB)`);
    return jsonRes(res, 200, { status: 'preloaded', modelId, free: totalFree() });
  }

  if (req.method === 'POST' && url === '/score') {
    const body = await readBody(req);
    const score = computeScore(body as { title?: string; body?: string; role?: string; labels?: string[]; estimatedFiles?: number });
    const role = (body.role as string) ?? 'dev';
    const recommended = (MODEL_PREFS[role] ?? MODEL_PREFS.dev!).find(m => MODELS[m]?.minScore !== undefined && MODELS[m]!.minScore <= score) ?? 'qwen3.5:4b';
    const ambiguous = score >= AMBIGUITY_ZONE_LOW && score <= AMBIGUITY_ZONE_HIGH;
    return jsonRes(res, 200, { score, recommended, quality: MODELS[recommended]?.quality, ambiguous });
  }

  if (req.method === 'POST' && url === '/human/heartbeat') {
    const { surface } = await readBody(req) as { surface: string };
    if (!['chat', 'vscode'].includes(surface)) return jsonRes(res, 400, { error: 'surface: chat or vscode' });
    return jsonRes(res, 200, await handleHeartbeat(surface));
  }

  if (req.method === 'POST' && url === '/human/token-end') {
    const switched = handleTokenEnd();
    if (state.mode === 'HUMAN_SHARED' || state.mode === 'HUMAN_EXCLUSIVE') {
      setImmediate(() => tryResumeAgents().catch(() => { /* silent */ }));
    }
    return jsonRes(res, 200, { switched, activeSurface: state.activeSurface, pendingSurface: state.pendingSurface, mode: state.mode, vramFree: totalFree() });
  }

  if (req.method === 'POST' && url === '/human/active')
    return jsonRes(res, 200, { mode: state.mode, ...await handleHeartbeat('chat') });

  if (req.method === 'POST' && url === '/human/inactive') {
    await resumeAgentsFull();
    return jsonRes(res, 200, { mode: state.mode });
  }

  jsonRes(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`GPU Scheduler v5 :${PORT} | ${totalVram()}GB VRAM | chat=${HUMAN_IDLE_CHAT_MS / 60000}min agents=${HUMAN_IDLE_AGENT_MS / 60000}min`);
  log(`Modes: AGENT_ACTIVE -> HUMAN_SHARED -> HUMAN_EXCLUSIVE | MIN_AGENT_VRAM=${MIN_AGENT_VRAM}GB`);
  log(`Models: ${Object.entries(MODELS).map(([id, m]) => `${id}(${m.vram}GB q=${m.quality}x${m.maxAgents})`).join(' | ')}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
