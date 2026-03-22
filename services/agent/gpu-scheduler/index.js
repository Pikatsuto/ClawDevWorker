#!/usr/bin/env node
/**
 * gpu-scheduler v5 — cohabitation HUMAN_SHARED + HUMAN_EXCLUSIVE
 *
 * RTX 2080 Ti : 11GB (gpu0)
 * GTX 1660    :  6GB (gpu1)
 * Total       : 17GB
 *
 * API:
 *   GET  /health
 *   GET  /status
 *   POST /enqueue                  → autonomous agent task
 *   POST /release                  → release agent slot
 *   POST /score                    → compute score without enqueuing
 *   POST /chat/request             → dispatch model for chat/vscode
 *   POST /chat/fanout              → enqueue N parallel VSCode subtasks
 *   POST /chat/release             → release chat slot
 *   POST /chat/session/lock        → lock model for session duration
 *   POST /chat/session/score       → evaluate a message, return upgrade/downgrade advice
 *   POST /chat/session/confirm     → confirm proposed upgrade or downgrade
 *   POST /chat/session/release     → release session (idle or disconnect)
 *   POST /human/heartbeat          → reset timer, handle surface preemption
 *   POST /human/token-end          → switch surface if preemption pending
 *   POST /human/active             → legacy API compat
 *   POST /human/inactive           → resume agents
 *
 * Modes:
 *   AGENT_ACTIVE    → agents run freely, all VRAM available
 *   HUMAN_SHARED    → human active, agents continue IF remaining VRAM allows it
 *                     If human takes more space → pause agents that overflow
 *                     When VRAM frees up → resume paused agents (incremental)
 *   HUMAN_EXCLUSIVE → human has taken all VRAM, no room for any agent
 *                     Agents paused until release
 *   (HUMAN_ACTIVE kept as alias for HUMAN_EXCLUSIVE for compat)
 *
 * Transition:
 *   heartbeat received → HUMAN_SHARED
 *     → recalculate VRAM after human session
 *     → if free < MIN_AGENT_VRAM → HUMAN_EXCLUSIVE, pause all
 *     → otherwise → HUMAN_SHARED, running agents continue
 *   Each human token → recalculate → resume agents if space has freed up
 *   idle 15min → AGENT_ACTIVE, everything resumes
 *
 * Session model lock:
 *   - First message → score algo → CPU tiebreaker if grey zone → model locked keep_alive=-1
 *   - score > session.minScore + UPGRADE_THRESHOLD → propose upgrade (chat/vscode)
 *                                                  → silent upgrade (agent AGENT_ACTIVE)
 *   - score < session.minScore - DOWNGRADE_THRESHOLD → lowScoreStreak++
 *     → streak >= 3 → propose downgrade (chat/vscode) / silent downgrade (agent)
 *   - HUMAN_EXCLUSIVE → agents: nothing changes
 */
'use strict';
const http = require('http');

const PORT                  = parseInt(process.env.SCHEDULER_PORT         || '7070');
const OLLAMA_URL            = process.env.OLLAMA_URL                      || 'http://ollama:11434';
const OLLAMA_CPU_URL        = process.env.OLLAMA_CPU_URL                  || 'http://ollama-cpu:11434';
const ORCHESTRATOR_URL      = process.env.ORCHESTRATOR_URL                || 'http://localhost:9001';
const HUMAN_IDLE_CHAT_MS    = parseInt(process.env.HUMAN_IDLE_CHAT_MS     || '900000');
const HUMAN_IDLE_AGENT_MS   = parseInt(process.env.HUMAN_IDLE_AGENT_MS    || '1800000');
const UPGRADE_THRESHOLD     = parseInt(process.env.UPGRADE_THRESHOLD      || '30');
const DOWNGRADE_THRESHOLD   = parseInt(process.env.DOWNGRADE_THRESHOLD    || '20');
const DOWNGRADE_STREAK_MAX  = parseInt(process.env.DOWNGRADE_STREAK_MAX   || '3');
const MIN_AGENT_VRAM        = parseInt(process.env.MIN_AGENT_VRAM         || '2');

// ── Model catalog — configurable via .env ─────────────────────────────────
// MODEL_COMPLEX   → score ≥ 70  (default: qwen3.5:27b-q3_k_m, 14GB)
// MODEL_STANDARD  → score 30-70 (default: qwen3.5:9b,          5GB)
// MODEL_LIGHT     → score 10-30 (default: qwen3.5:4b,          3GB)
// MODEL_TRIVIAL   → score < 10  (default: qwen3.5:2b,          2GB)
// MODEL_CPU       → CPU only    (default: qwen3.5:0.8b,        0GB)
//
// VRAM_COMPLEX / VRAM_STANDARD / VRAM_LIGHT / VRAM_TRIVIAL permettent
// to adjust if the chosen model has a different footprint.

const M_COMPLEX  = process.env.MODEL_COMPLEX  || 'qwen3.5:27b-q3_k_m';
const M_STANDARD = process.env.MODEL_STANDARD || 'qwen3.5:9b';
const M_LIGHT    = process.env.MODEL_LIGHT    || 'qwen3.5:4b';
const M_TRIVIAL  = process.env.MODEL_TRIVIAL  || 'qwen3.5:2b';
const M_CPU      = process.env.MODEL_CPU      || 'qwen3.5:0.8b';

const VRAM_COMPLEX  = parseInt(process.env.VRAM_COMPLEX  || '14');
const VRAM_STANDARD = parseInt(process.env.VRAM_STANDARD || '5');
const VRAM_LIGHT    = parseInt(process.env.VRAM_LIGHT    || '3');
const VRAM_TRIVIAL  = parseInt(process.env.VRAM_TRIVIAL  || '2');

// Catalog built dynamically at startup
const MODELS = {
  [M_COMPLEX]:  { vram: VRAM_COMPLEX,  quality:10, maxAgents:1, thinking:true,  minScore:70 },
  [M_STANDARD]: { vram: VRAM_STANDARD, quality: 7, maxAgents:3, thinking:true,  minScore:30 },
  [M_LIGHT]:    { vram: VRAM_LIGHT,    quality: 4, maxAgents:4, thinking:true,  minScore:10 },
  [M_TRIVIAL]:  { vram: VRAM_TRIVIAL,  quality: 2, maxAgents:6, thinking:true,  minScore: 0 },
  [M_CPU]:      { vram: 0,             quality: 1, maxAgents:8, thinking:false, minScore: 0 },
};

// All specialist roles share the same model preferences
const SPECIALIST_ROLES = [
  'architect','frontend','backend','fullstack','devops','security','qa','doc',
  'marketing','design','product','bizdev',
];

const MODEL_PREFS = {
  chat:  [M_COMPLEX, M_STANDARD, M_LIGHT, M_TRIVIAL],
  audit: [M_STANDARD, M_LIGHT, M_TRIVIAL],
};
// Inject all specialist roles with the same list
for (const role of SPECIALIST_ROLES) {
  MODEL_PREFS[role] = [M_COMPLEX, M_STANDARD, M_LIGHT, M_TRIVIAL];
}
// Compat legacy
MODEL_PREFS.dev = MODEL_PREFS.frontend;
MODEL_PREFS.qa  = [M_STANDARD, M_LIGHT, M_TRIVIAL];

// Upgrade/downgrade paths — built dynamically
const MODEL_UPGRADE = {
  [M_TRIVIAL]:  M_LIGHT,
  [M_LIGHT]:    M_STANDARD,
  [M_STANDARD]: M_COMPLEX,
  [M_COMPLEX]:  null,
};
const MODEL_DOWNGRADE = {
  [M_COMPLEX]:  M_STANDARD,
  [M_STANDARD]: M_LIGHT,
  [M_LIGHT]:    M_TRIVIAL,
  [M_TRIVIAL]:  null,
};

const GPUS = [
  { id:'gpu0', name:'RTX 2080 Ti', total:11, reserved:0 },
  { id:'gpu1', name:'GTX 1660',    total: 6, reserved:0 },
];
const totalVram = () => GPUS.reduce((a,g) => a+g.total, 0);
const totalFree = () => GPUS.reduce((a,g) => a+g.total-g.reserved, 0);

const KW = {
  critical:['security','auth','migration','database','architecture','refactor','refacto','system','deploy','infrastructure','performance','breaking','cve','vulnerability'],
  high:    ['feature','api','integration','multi','async','concurrent','cache','algorithm','search','indexing'],
  medium:  ['bug','fix','error','crash','regression','test','validation'],
  low:     ['typo','css','style','rename','copy','wording','comment','doc','documentation','readme','indent','format','lint'],
};

const state = {
  mode:               'AGENT_ACTIVE',
  humanLastSeen:      0,
  humanIdleTimer:     null,
  activeSurface:      null,
  waitingForTokenEnd: false,
  pendingSurface:     null,
  chatSlots:          new Map(),
  loadedModels:       new Map(),
  activeSlots:        new Map(),
  colocGroups:        new Map(),
  queue:              [],
  pausedTasks:        new Map(),

  // Chat/vscode sessions — model locked for session duration
  // sessionId → {
  //   modelId, surface, lockedAt,
  //   lowScoreStreak,   // number of consecutive messages below threshold
  //   pendingDowngrade, // model proposed for downgrade, awaiting confirmation
  //   pendingUpgrade,   // model proposed for upgrade, awaiting confirmation
  //   lastScore,
  // }
  sessionModels: new Map(),
};

let slotCounter  = 0;
let groupCounter = 0;

const log = (msg, lvl='INFO') =>
  console.log(`[gpu-scheduler] ${new Date().toISOString()} [${lvl}] ${msg}`);

// ── VRAM ──────────────────────────────────────────────────────────────────────

function allocateVram(vramNeeded) {
  const free = GPUS.map(g => ({...g, free:g.total-g.reserved}));
  for (const gpu of free.sort((a,b) => b.free-a.free)) {
    if (gpu.free >= vramNeeded) {
      GPUS.find(g=>g.id===gpu.id).reserved += vramNeeded;
      return [gpu.id];
    }
  }
  if (free.reduce((a,g) => a+g.free, 0) >= vramNeeded) {
    let rem = vramNeeded; const allocated = [];
    for (const gpu of free.sort((a,b) => b.free-a.free)) {
      if (rem<=0) break;
      const take = Math.min(gpu.free, rem);
      if (take>0) { GPUS.find(g=>g.id===gpu.id).reserved += take; allocated.push(gpu.id); rem -= take; }
    }
    return allocated;
  }
  return null;
}

function releaseVram(gpuIds, vramTotal) {
  const perGpu = vramTotal/gpuIds.length;
  for (const id of gpuIds) {
    const gpu = GPUS.find(g=>g.id===id);
    if (gpu) gpu.reserved = Math.max(0, gpu.reserved-perGpu);
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function computeScore({title='',body='',role='dev',labels=[],estimatedFiles=1}) {
  let score = 30;
  const text = `${title} ${body}`.toLowerCase();
  for (const kw of KW.critical) if (text.includes(kw)) score += 15;
  for (const kw of KW.high)     if (text.includes(kw)) score += 8;
  for (const kw of KW.medium)   if (text.includes(kw)) score += 4;
  for (const kw of KW.low)      if (text.includes(kw)) score -= 10;
  if (role==='qa')    score -= 15;
  if (role==='audit') score -= 10;
  if (body.length>2000) score+=10; else if (body.length>500) score+=5; else if (body.length<100) score-=5;
  if (estimatedFiles>10) score+=15; else if (estimatedFiles>5) score+=8; else if (estimatedFiles>2) score+=4;
  if (labels.some(l=>['critical','security','priority:high'].includes(l.toLowerCase()))) score+=20;
  if (labels.some(l=>['good first issue','trivial','easy'].includes(l.toLowerCase())))   score-=15;
  return Math.max(0, Math.min(100, score));
}

function computeChatScore(messages=[]) {
  const lastUser = [...messages].reverse().find(m => m.role==='user');
  if (!lastUser) return 30;
  const content = typeof lastUser.content==='string'
    ? lastUser.content
    : (lastUser.content||[]).map(c=>c.text||'').join(' ');
  let score = 20;
  const text = content.toLowerCase();
  if (content.length>1000) score+=20; else if (content.length>300) score+=10; else if (content.length<50) score-=10;
  for (const kw of KW.critical) if (text.includes(kw)) score+=12;
  for (const kw of KW.high)     if (text.includes(kw)) score+=6;
  for (const kw of KW.medium)   if (text.includes(kw)) score+=3;
  for (const kw of KW.low)      if (text.includes(kw)) score-=8;
  if ([/^(what is|how do|why)\b/i,/\?$/,/^(thanks|ok|yes|no)\b/i]
      .some(p=>p.test(content.trim()))) score-=15;
  if (/\b(refactor|rewrite|implement|create|generate)\b/i.test(text)) score+=15;
  if (/\b(file|class|module|component)\b/i.test(text)) score+=8;
  return Math.max(0, Math.min(100, score));
}

// ── Dispatch chat/vscode ──────────────────────────────────────────────────────
// Priority:
//   1. Loaded model with free slot (highest quality first)
//   2. n+1 already loaded with free slot — opportunistic
//   3. Load ideal model if enough VRAM
//   4. Fallback CPU

function dispatchChatModel(score) {
  const prefs   = MODEL_PREFS.chat;
  const idealId = prefs.find(m => MODELS[m]?.minScore<=score) || prefs[prefs.length-1];
  const idealQ  = MODELS[idealId]?.quality || 0;

  // 1+2: free slot on already loaded model
  const candidates = [];
  for (const modelId of prefs) {
    const loaded = state.loadedModels.get(modelId);
    if (!loaded) continue;
    if (loaded.agentSlots.size < MODELS[modelId].maxAgents) {
      candidates.push({ modelId, quality: MODELS[modelId].quality, reuse:true });
    }
  }
  if (candidates.length>0) {
    const best = candidates
      .filter(c => c.quality >= idealQ-2)
      .sort((a,b) => b.quality-a.quality)[0]
      || candidates.sort((a,b) => b.quality-a.quality)[0];
    log(`Chat dispatch: reusing ${best.modelId} (score=${score})`);
    return { modelId:best.modelId, ollamaUrl:OLLAMA_URL, fallback:false, reuse:true };
  }

  // 3: load ideal model
  const idealModel = MODELS[idealId];
  if (idealModel && totalFree()>=idealModel.vram) {
    log(`Chat dispatch: loading ${idealId} (score=${score}, free=${totalFree()}GB)`);
    return { modelId:idealId, ollamaUrl:OLLAMA_URL, fallback:false, reuse:false };
  }

  // 4: fallback CPU
  log(`Chat dispatch: fallback CPU (score=${score}, free=${totalFree()}GB)`, 'WARN');
  return { modelId:'qwen3.5:0.8b', ollamaUrl:OLLAMA_CPU_URL, fallback:true, reuse:false };
}

// ── Session model — lock + streak upgrade/downgrade ───────────────────────────
//
// Identical logic for chat, vscode and autonomous agents.
// The difference is in the action:
//   chat/vscode  → returns a proposal, waits for human confirmation
//   agent        → applies silently if AGENT_ACTIVE

/**
 * Creates or returns a session for a sessionId.
 * On first call: chooses the model via dispatchChatModel and locks it.
 */
async function getOrCreateSession(sessionId, surface, messages) {
  if (state.sessionModels.has(sessionId)) return state.sessionModels.get(sessionId);

  const score    = computeChatScore(messages);
  const dispatch = dispatchChatModel(score);

  // Load model if needed and allocate VRAM
  if (!dispatch.fallback && !dispatch.reuse) {
    const model = MODELS[dispatch.modelId];
    const gpus  = allocateVram(model.vram);
    if (gpus) {
      await loadModel(dispatch.modelId);
      if (!state.loadedModels.has(dispatch.modelId))
        state.loadedModels.set(dispatch.modelId, { vram:model.vram, gpus, agentSlots:new Map(), loadedAt:Date.now() });
    }
  }

  const session = {
    modelId:         dispatch.modelId,
    ollamaUrl:       dispatch.ollamaUrl,
    fallback:        dispatch.fallback,
    surface,
    lockedAt:        Date.now(),
    lowScoreStreak:  0,
    pendingDowngrade: null,
    pendingUpgrade:   null,
    lastScore:        score,
  };

  state.sessionModels.set(sessionId, session);
  log(`Session ${sessionId} locked on ${dispatch.modelId} (score=${score} surface=${surface})`);
  return session;
}

/**
 * Evaluates a message in the context of an existing session.
 * Returns the action to take:
 *   { action: 'ok',        modelId, ollamaUrl }          → continue normally
 *   { action: 'upgrade',   modelId, targetModel, vramDelta, reason }
 *   { action: 'downgrade', modelId, targetModel, vramFreed, reason }
 *
 * For agents (surface='agent'): applies directly if AGENT_ACTIVE.
 */
async function evaluateSessionMessage(sessionId, messages) {
  const session = state.sessionModels.get(sessionId);
  if (!session) return { action: 'no_session' };

  const score    = computeChatScore(messages);
  const model    = MODELS[session.modelId];
  const minScore = model?.minScore ?? 0;

  session.lastScore = score;

  // ── Upgrade: score spikes ───────────────────────────────────────────────
  if (score > minScore + UPGRADE_THRESHOLD) {
    session.lowScoreStreak = 0;
    const targetModel = MODEL_UPGRADE[session.modelId];
    if (!targetModel) return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };

    const targetVram = MODELS[targetModel]?.vram ?? 0;
    const currentVram = model?.vram ?? 0;
    const vramDelta = targetVram - currentVram;
    const hasFreeVram = totalFree() >= vramDelta;
    const reason = `Score ${score} exceeds current model threshold (${session.modelId}, minScore=${minScore}) by +${score - minScore - UPGRADE_THRESHOLD} points`;

    if (session.surface === 'agent') {
      // Autonomous agent → silent upgrade unless human exclusive
      if (state.mode !== 'HUMAN_EXCLUSIVE' && state.mode !== 'HUMAN_ACTIVE' && hasFreeVram) {
        await applySessionModelChange(sessionId, targetModel);
        log(`Session ${sessionId} silently upgraded → ${targetModel} (score=${score})`);
        return { action:'ok', modelId:targetModel, ollamaUrl:OLLAMA_URL, silent:true };
      }
      return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };
    }

    // Chat/vscode → proposal (no pending confirmation already)
    if (!session.pendingUpgrade) {
      session.pendingUpgrade = targetModel;
      const vramInfo = hasFreeVram
        ? `${vramDelta}GB additional available`
        : `missing ${vramDelta - totalFree()}GB — some agents will be paused`;
      return {
        action: 'upgrade',
        modelId: session.modelId,
        targetModel,
        ollamaUrl: session.ollamaUrl,
        vramDelta,
        hasFreeVram,
        reason,
        message: `⬆️ This task deserves a more powerful model.\n` +
                 `Switch to **${targetModel}** (${vramInfo}).\n` +
                 `Reply \`/upgrade\` to confirm or continue with the current model.`,
      };
    }
    return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };
  }

  // ── Downgrade: low score over N consecutive messages ─────────────────────
  if (score < minScore - DOWNGRADE_THRESHOLD) {
    session.lowScoreStreak++;

    if (session.lowScoreStreak >= DOWNGRADE_STREAK_MAX) {
      session.lowScoreStreak = 0; // reset — attend confirmation avant de recompter
      const targetModel = MODEL_DOWNGRADE[session.modelId];
      if (!targetModel) return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };

      const vramFreed = (model?.vram ?? 0) - (MODELS[targetModel]?.vram ?? 0);

      if (session.surface === 'agent') {
        // Autonomous agent → silent downgrade unless human exclusive
        if (state.mode !== 'HUMAN_EXCLUSIVE' && state.mode !== 'HUMAN_ACTIVE') {
          await applySessionModelChange(sessionId, targetModel);
          log(`Session ${sessionId} silently downgraded → ${targetModel} (streak=${DOWNGRADE_STREAK_MAX})`);
          return { action:'ok', modelId:targetModel, ollamaUrl:OLLAMA_URL, silent:true };
        }
        return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };
      }

      // Chat/vscode → proposal
      if (!session.pendingDowngrade) {
        session.pendingDowngrade = targetModel;
        return {
          action: 'downgrade',
          modelId: session.modelId,
          targetModel,
          ollamaUrl: session.ollamaUrl,
          vramFreed,
          message: `💡 The last ${DOWNGRADE_STREAK_MAX} messages don't require **${session.modelId}**.\n` +
                   `Switching to **${targetModel}** would free **${vramFreed}GB** of VRAM for your agents.\n` +
                   `Reply \`/downgrade\` to confirm or continue normally.`,
        };
      }
    }
    // Streak in progress but not reached yet → continue normally
    return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };
  }

  // ── Normal score → reset streak ───────────────────────────────────────────
  session.lowScoreStreak = 0;
  session.pendingUpgrade   = null; // cancel upgrade proposal if score returns to normal
  return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };
}

/**
 * Applies a model change on a session (upgrade or downgrade).
 * Releases the old model if no slot is using it anymore, loads the new one.
 */
async function applySessionModelChange(sessionId, targetModelId) {
  const session = state.sessionModels.get(sessionId);
  if (!session) return false;

  const oldModelId = session.modelId;
  const targetModel = MODELS[targetModelId];
  if (!targetModel) return false;

  // Release old model if no other slot is using it
  const loaded = state.loadedModels.get(oldModelId);
  if (loaded) {
    // Remove session slot from old model
    for (const [k, v] of loaded.agentSlots) {
      if (v === sessionId) { loaded.agentSlots.delete(k); break; }
    }
    if (loaded.agentSlots.size === 0) {
      releaseVram(loaded.gpus, loaded.vram);
      await unloadModel(oldModelId);
    }
  }

  // Load new model
  const gpus = allocateVram(targetModel.vram);
  if (gpus) {
    await loadModel(targetModelId);
    if (!state.loadedModels.has(targetModelId))
      state.loadedModels.set(targetModelId, { vram:targetModel.vram, gpus, agentSlots:new Map(), loadedAt:Date.now() });
  }

  session.modelId          = targetModelId;
  session.ollamaUrl        = OLLAMA_URL;
  session.fallback         = false;
  session.pendingDowngrade = null;
  session.pendingUpgrade   = null;
  session.lowScoreStreak   = 0;

  log(`Session ${sessionId}: ${oldModelId} → ${targetModelId}`);
  return true;
}

/**
 * Releases a session and unloads the model if no users remain.
 */
async function releaseSession(sessionId) {
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
}

const AMBIGUITY_ZONE_LOW  = 45;
const AMBIGUITY_ZONE_HIGH = 75;

async function cpuAmbiguityCheck({title,body,role,score,queueLength,currentModel,degradedModel}) {
  if (score<=AMBIGUITY_ZONE_LOW||score>=AMBIGUITY_ZONE_HIGH) return null;
  if (queueLength<=1) return null;
  const currentQ  = MODELS[currentModel]?.quality  || 0;
  const degradedQ = MODELS[degradedModel]?.quality || 0;
  if (currentQ-degradedQ>3) return null;
  const prompt = [`Issue: "${title}"`, body?`Description: "${body.slice(0,300)}"`:'',
    `Role: ${role} | Score: ${score}/100`,
    `Current model: ${currentModel} (q=${currentQ}/10) → degraded: ${degradedModel} (q=${degradedQ}/10)`,
    `Queue: ${queueLength} tasks`,
    `Degrade to free an additional GPU slot? YES or NO.`
  ].filter(Boolean).join('\n');
  try {
    const res = await ollamaReq('POST','/api/generate',{
      model:'qwen3.5:0.8b', prompt, stream:false, keep_alive:0,
      options:{num_gpu:0, num_predict:5, temperature:0}
    }, OLLAMA_CPU_URL);
    const decision = (res.response||'').trim().toUpperCase().startsWith('YES')?'degrade':'keep';
    log(`CPU ambiguity → ${decision}`);
    return decision;
  } catch(e) { log(`CPU ambiguity failed: ${e.message}`,'WARN'); return null; }
}

// ── Algo planQueue ────────────────────────────────────────────────────────────

function evalPlan(plan, queueSize) {
  if (!plan.length) return 0;
  const qualityNorm  = plan.reduce((a,p)=>a+(MODELS[p.modelId]?.quality||0),0)/(plan.length*10);
  const parallelNorm = plan.length/Math.max(queueSize,1);
  return qualityNorm*0.7 + parallelNorm*0.3;
}

function planQueue() {
  if (!state.queue.length) return [];

  // Routing MODEL_<ROLE> from .env — priority override over MODEL_PREFS
  // E.g.: MODEL_MARKETING=mistral:7b → used first for the marketing gate
  function getPrefsForRole(role) {
    const envKey   = `MODEL_${role.toUpperCase()}`;
    const envModel = process.env[envKey];
    const base     = MODEL_PREFS[role] || MODEL_PREFS.dev;
    if (envModel && !base.includes(envModel)) {
      // Inject specific model at head + add to catalog if unknown
      if (!MODELS[envModel]) {
        MODELS[envModel] = { vram: 5, quality: 7, maxAgents: 3, thinking: true, minScore: 0 };
        log(`MODEL_${role.toUpperCase()}=${envModel} loaded from .env (estimated vram 5GB)`);
      }
      return [envModel, ...base];
    }
    return base;
  }

  const sorted    = [...state.queue].sort((a,b)=>b.score-a.score);
  const queueSize = sorted.length;
  let bestPlan=[], bestScore=-1;

  for (const qualityThreshold of [85,70,55,40,0]) {
    const simGpus   = GPUS.map(g=>({...g}));
    const simLoaded = new Map([...state.loadedModels.entries()].map(([k,v])=>[k,{...v,agentSlots:new Map(v.agentSlots)}]));
    const simFree   = ()=>simGpus.reduce((a,g)=>a+g.total-g.reserved,0);
    const plan = [];

    for (const task of sorted) {
      const prefs = getPrefsForRole(task.role);
      let allocated = false;

      for (const modelId of prefs) {
        const loaded = simLoaded.get(modelId);
        if (!loaded) continue;
        const model = MODELS[modelId];
        if (loaded.agentSlots.size>=model.maxAgents||model.minScore>task.score) continue;
        if (task.score>qualityThreshold) {
          if ((MODELS[prefs[0]]?.quality||10)-model.quality>2) continue;
        }
        loaded.agentSlots.set(`sim-${plan.length}`,task.taskId);
        plan.push({taskId:task.taskId, modelId, reuse:true});
        allocated=true; break;
      }
      if (allocated) continue;

      for (const modelId of prefs) {
        const model = MODELS[modelId];
        if (!model||model.minScore>task.score) continue;
        if (modelId!==prefs[0]&&task.score>qualityThreshold) {
          if ((MODELS[prefs[0]]?.quality||10)-model.quality>2) continue;
        }
        if (simFree()<model.vram) continue;
        let rem=model.vram; const gpus=[];
        for (const g of [...simGpus].sort((a,b)=>(b.total-b.reserved)-(a.total-a.reserved))) {
          if (rem<=0) break;
          const take=Math.min(g.total-g.reserved,rem);
          if (take>0){simGpus.find(sg=>sg.id===g.id).reserved+=take; gpus.push(g.id); rem-=take;}
        }
        simLoaded.set(modelId,{vram:model.vram,gpus,agentSlots:new Map([[`sim-${plan.length}`,task.taskId]])});
        plan.push({taskId:task.taskId, modelId, reuse:false, gpus});
        allocated=true; break;
      }
    }

    const sc = evalPlan(plan, queueSize);
    if (sc>bestScore){bestScore=sc; bestPlan=plan;}
  }

  if (bestPlan.length>0) {
    const summary = [...new Set(bestPlan.map(p=>p.modelId))]
      .map(m=>`${m}(×${bestPlan.filter(p=>p.modelId===m).length})`).join(', ');
    log(`Plan: ${bestPlan.length}/${queueSize} tasks | score=${bestScore.toFixed(3)} | ${summary}`);
  }
  return bestPlan;
}

// ── Co-localisation ───────────────────────────────────────────────────────────

function canColocate(t1,t2) {
  if (t1.repo!==t2.repo) return false;
  if (t1.role==='audit'&&t2.role==='audit') return true;
  if (t1.parentGroup&&t1.parentGroup===t2.parentGroup) return true;
  if (t1.branch&&t1.branch===t2.branch) return true;
  return false;
}

function findOrCreateColocGroup(task) {
  for (const [groupId,group] of state.colocGroups) {
    if (group.repo!==task.repo) continue;
    const anyTask = state.queue.find(t=>group.taskIds.includes(t.taskId))
      ||[...state.activeSlots.values()].find(s=>group.taskIds.includes(s.taskId));
    if (anyTask&&canColocate(task,anyTask)) return groupId;
  }
  for (const queued of state.queue) {
    if (queued.taskId===task.taskId) continue;
    if (canColocate(task,queued)) {
      const groupId=`group-${++groupCounter}`;
      state.colocGroups.set(groupId,{repo:task.repo,branch:task.branch||queued.branch,taskIds:[queued.taskId,task.taskId],modelId:null,slotIds:[]});
      log(`Groupe co-loc ${groupId}: ${queued.taskId} + ${task.taskId}`);
      return groupId;
    }
  }
  return null;
}

// ── Ollama ────────────────────────────────────────────────────────────────────

function ollamaReq(method, urlPath, body=null, baseUrl=OLLAMA_URL) {
  return new Promise((resolve,reject) => {
    const url     = new URL(urlPath, baseUrl);
    const payload = body?JSON.stringify(body):null;
    const opts    = {method, hostname:url.hostname, port:url.port||11434, path:url.pathname,
      headers:payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}};
    const req = http.request(opts, res=>{let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d));}catch{resolve(d);}});});
    req.on('error',reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadModel(modelId) {
  if (state.loadedModels.has(modelId)) return;
  log(`Loading: ${modelId}`);
  try {
    await ollamaReq('POST','/api/generate',{model:modelId,keep_alive:-1,prompt:'',options:{num_parallel:MODELS[modelId]?.maxAgents||2}});
    log(`${modelId} ready (max ${MODELS[modelId]?.maxAgents} agents)`);
  } catch(e){log(`Error loading ${modelId}: ${e.message}`,'WARN');}
}

async function unloadModel(modelId) {
  try {
    await ollamaReq('POST','/api/generate',{model:modelId,keep_alive:0,prompt:''});
    state.loadedModels.delete(modelId);
    log(`${modelId} unloaded`);
  } catch(e){log(`Error unloading ${modelId}: ${e.message}`,'WARN');}
}

// ── Human priority — HUMAN_SHARED / HUMAN_EXCLUSIVE cohabitation ───────────
//
// HUMAN_SHARED    : human active, agents continue if enough VRAM
// HUMAN_EXCLUSIVE : human took all space, agents paused
// AGENT_ACTIVE    : human idle, agents free
//
// Alias: HUMAN_ACTIVE = HUMAN_EXCLUSIVE (compat)

/**
 * Computes VRAM consumed by human slots (chat/vscode).
 * = sum of VRAM of models loaded only for chat slots.
 */
function humanVramUsed() {
  let used = 0;
  for (const [modelId, loaded] of state.loadedModels) {
    // A model is "human" if at least one of its slots is a chat slot
    const hasChatSlot = [...state.chatSlots.values()].some(s => s.modelId === modelId);
    if (hasChatSlot) used += loaded.vram;
  }
  return used;
}

/**
 * VRAM actually available for autonomous agents
 * = totalFree() - safety margin for potential human model loads
 */
function agentFreeVram() {
  return Math.max(0, totalFree());
}

/**
 * Pauses only agents that no longer have enough VRAM.
 * Keeps running those already allocated if VRAM is sufficient.
 * Called when transitioning to HUMAN_SHARED or HUMAN_EXCLUSIVE.
 */
async function pauseAgentsIfNeeded() {
  const free = agentFreeVram();
  log(`🧑 HUMAN_SHARED — VRAM free=${free}GB MIN_AGENT=${MIN_AGENT_VRAM}GB`);

  if (free >= MIN_AGENT_VRAM) {
    // Enough space — active agents can stay
    // Only block new allocations from the queue
    log('Active agents maintained (VRAM sufficient)');
    return;
  }

  // Not enough space — switch to HUMAN_EXCLUSIVE, pause all
  log('⚠️ Insufficient VRAM for cohabitation → HUMAN_EXCLUSIVE','WARN');
  state.mode = 'HUMAN_EXCLUSIVE';

  for (const [slotId, slot] of state.activeSlots) {
    state.pausedTasks.set(slot.taskId, { slotId, ...slot, pausedAt: Date.now() });
    notify(ORCHESTRATOR_URL, 'pause', { taskId: slot.taskId });
  }
  state.activeSlots.clear();

  // Unload agent models (keep human models loaded)
  for (const [modelId, loaded] of state.loadedModels) {
    const hasChatSlot = [...state.chatSlots.values()].some(s => s.modelId === modelId);
    if (!hasChatSlot) {
      releaseVram(loaded.gpus, loaded.vram);
      await unloadModel(modelId);
    }
  }
  // Clean up agent loadedModels
  for (const modelId of [...state.loadedModels.keys()]) {
    const hasChatSlot = [...state.chatSlots.values()].some(s => s.modelId === modelId);
    if (!hasChatSlot) state.loadedModels.delete(modelId);
  }

  log(`HUMAN_EXCLUSIVE — free=${totalFree()}GB`);
}

/**
 * Attempts to resume paused agents if VRAM has freed up.
 * Called after each human slot release (token-end, session/release).
 * Incremental: resumes as many agents as VRAM allows.
 */
async function tryResumeAgents() {
  if (state.mode === 'AGENT_ACTIVE') return;
  if (!state.pausedTasks.size) return;

  const free = agentFreeVram();
  if (free < MIN_AGENT_VRAM) {
    log(`tryResumeAgents: VRAM ${free}GB < ${MIN_AGENT_VRAM}GB → no resume`);
    return;
  }

  log(`↩️ VRAM ${free}GB available — attempting to resume paused agents`);

  // Switch to HUMAN_SHARED if we were HUMAN_EXCLUSIVE
  if (state.mode === 'HUMAN_EXCLUSIVE' || state.mode === 'HUMAN_ACTIVE') {
    state.mode = 'HUMAN_SHARED';
  }

  // Put paused tasks back in queue for processQueue()
  for (const [taskId, ctx] of state.pausedTasks) {
    state.queue.push({
      taskId, repo: ctx.repo, issueId: ctx.issueId, role: ctx.role,
      score: ctx.score, branch: ctx.branch, parentGroup: ctx.colocGroup,
      addedAt: Date.now(),
    });
    notify(ORCHESTRATOR_URL, 'resume', { taskId });
    state.pausedTasks.delete(taskId);
  }

  await processQueue();
}

/**
 * Full resume — human idle for HUMAN_IDLE_CHAT_MS.
 */
async function resumeAgentsFull() {
  if (state.mode === 'AGENT_ACTIVE') return;
  log(`🤖 AGENT_ACTIVE — human idle ${HUMAN_IDLE_CHAT_MS/60000}min`);
  state.mode         = 'AGENT_ACTIVE';
  state.activeSurface = null;

  for (const [taskId, ctx] of state.pausedTasks) {
    state.queue.unshift({
      taskId, repo: ctx.repo, issueId: ctx.issueId, role: ctx.role,
      score: ctx.score, branch: ctx.branch, parentGroup: ctx.colocGroup,
      addedAt: Date.now(),
    });
    notify(ORCHESTRATOR_URL, 'resume', { taskId });
  }
  state.pausedTasks.clear();
  await processQueue();
}

function scheduleIdleCheck() {
  if (state.humanIdleTimer) clearTimeout(state.humanIdleTimer);
  state.humanIdleTimer = setTimeout(async () => {
    if (Date.now() - state.humanLastSeen >= HUMAN_IDLE_CHAT_MS) {
      log(`Human idle ${HUMAN_IDLE_CHAT_MS/60000}min → AGENT_ACTIVE`);
      await resumeAgentsFull();
    }
  }, HUMAN_IDLE_CHAT_MS);
}

async function handleHeartbeat(surface) {
  state.humanLastSeen = Date.now();

  // Handle preemption between surfaces (chat ↔ vscode)
  if (state.activeSurface && state.activeSurface !== surface) {
    if (state.waitingForTokenEnd) {
      state.pendingSurface = surface;
      return { ok: true, surface, preempting: true, waiting: true };
    }
    log(`Surface ${surface} preempts ${state.activeSurface} (waiting for token end)`, 'WARN');
    state.waitingForTokenEnd = true;
    state.pendingSurface     = surface;
    return { ok: true, surface, preempting: true, waiting: true };
  }

  state.activeSurface = surface;

  // First time human arrives (from AGENT_ACTIVE)
  if (state.mode === 'AGENT_ACTIVE') {
    state.mode = 'HUMAN_SHARED';
    log(`🧑 ${surface} active → HUMAN_SHARED`);
    await pauseAgentsIfNeeded();
  }
  // If already in human mode, recalculate on each heartbeat (token)
  // to resume agents if VRAM has freed up in the meantime
  else if (state.mode === 'HUMAN_EXCLUSIVE' || state.mode === 'HUMAN_ACTIVE') {
    await tryResumeAgents();
  }

  scheduleIdleCheck();
  const mode = state.mode;
  const free = agentFreeVram();
  return { ok: true, surface, mode, vramFree: free, agentsCanRun: free >= MIN_AGENT_VRAM };
}

function handleTokenEnd() {
  if (!state.waitingForTokenEnd || !state.pendingSurface) return false;
  const prev = state.activeSurface;
  state.activeSurface      = state.pendingSurface;
  state.waitingForTokenEnd = false;
  state.pendingSurface     = null;
  log(`Surface switch ${prev} → ${state.activeSurface}`);
  scheduleIdleCheck();
  return true;
}

// ── Notifications ─────────────────────────────────────────────────────────────

function notify(baseUrl, event, data) {
  try {
    const body = JSON.stringify({event,...data});
    const url  = new URL('/scheduler-event',baseUrl);
    const req  = http.request({method:'POST',hostname:url.hostname,port:url.port,path:url.pathname,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}});
    req.on('error',()=>{}); req.write(body); req.end();
  } catch {}
}

// ── processQueue ──────────────────────────────────────────────────────────────

async function processQueue() {
  // HUMAN_EXCLUSIVE (no more VRAM available) or HUMAN_ACTIVE (compat) → block
  if (state.mode==='HUMAN_EXCLUSIVE'||state.mode==='HUMAN_ACTIVE') return;
  if (!state.queue.length) return;

  // HUMAN_SHARED → only allocate if remaining VRAM allows it
  const maxVramForAgents = state.mode==='HUMAN_SHARED'
    ? agentFreeVram()
    : Infinity;

  if (state.mode==='HUMAN_SHARED' && maxVramForAgents < MIN_AGENT_VRAM) {
    log(`processQueue: HUMAN_SHARED VRAM ${maxVramForAgents}GB < ${MIN_AGENT_VRAM}GB → pause`);
    return;
  }

  const plan = planQueue();
  if (!plan.length) return;

  for (const allocation of plan) {
    const taskIdx = state.queue.findIndex(t=>t.taskId===allocation.taskId);
    if (taskIdx===-1) continue;
    const task = state.queue[taskIdx];
    try {
      let loaded = state.loadedModels.get(allocation.modelId);
      if (!allocation.reuse||!loaded) {
        const model = MODELS[allocation.modelId];
        const gpus  = allocateVram(model.vram);
        if (!gpus){log(`Insufficient VRAM for ${allocation.modelId}`,'WARN'); continue;}
        await loadModel(allocation.modelId);
        loaded={vram:model.vram,gpus,agentSlots:new Map(),loadedAt:Date.now()};
        state.loadedModels.set(allocation.modelId,loaded);
      }
      const model=MODELS[allocation.modelId];
      if (loaded.agentSlots.size>=model.maxAgents){log(`${allocation.modelId} saturated`,'WARN'); continue;}
      const slotId=`slot-${++slotCounter}`;
      loaded.agentSlots.set(slotId,task.taskId);
      const colocGroupId=task.parentGroup||findOrCreateColocGroup(task);
      if (colocGroupId){const g=state.colocGroups.get(colocGroupId); if(g){g.slotIds.push(slotId); g.modelId=g.modelId||allocation.modelId;}}
      state.activeSlots.set(slotId,{taskId:task.taskId,modelId:allocation.modelId,role:task.role,score:task.score,repo:task.repo,issueId:task.issueId,branch:task.branch,colocGroup:colocGroupId,reservedAt:Date.now()});
      state.queue.splice(taskIdx,1);
      const used=loaded.agentSlots.size;
      log(`✅ ${slotId}: ${task.taskId} → ${allocation.modelId} [score=${task.score} q=${model.quality} agents=${used}/${model.maxAgents} ${allocation.reuse?'reused':'new'} free=${totalFree()}GB${colocGroupId?` coloc=${colocGroupId}`:''}]`);
      notify(ORCHESTRATOR_URL,'slot-ready',{taskId:task.taskId,slotId,modelId:allocation.modelId,gpus:loaded.gpus,colocGroup:colocGroupId,agentIndex:used-1});
    } catch(e){log(`Error allocating ${task.taskId}: ${e.message}`,'WARN');}
  }
  log(`VRAM: ${totalFree()}/${totalVram()}GB free | active=${state.activeSlots.size} | queue=${state.queue.length}`);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

const json    = (res,code,data) => { const b=JSON.stringify(data,null,2); res.writeHead(code,{'Content-Type':'application/json'}); res.end(b); };
const readBody = req => new Promise(r=>{let d=''; req.on('data',c=>d+=c); req.on('end',()=>{try{r(JSON.parse(d));}catch{r({});}});});

const server = http.createServer(async(req,res) => {
  const url = req.url.split('?')[0];

  if (req.method==='GET'&&url==='/health')
    return json(res,200,{ok:true,mode:state.mode,activeSurface:state.activeSurface});

  if (req.method==='GET'&&url==='/status')
    return json(res,200,{
      mode:state.mode, activeSurface:state.activeSurface, humanLastSeen:state.humanLastSeen,
      gpus:GPUS.map(g=>({...g,free:g.total-g.reserved,usedPct:Math.round(g.reserved/g.total*100)})),
      totalFree:totalFree(), totalVram:totalVram(),
      loadedModels:[...state.loadedModels.entries()].map(([id,m])=>({modelId:id,vram:m.vram,gpus:m.gpus,agents:m.agentSlots.size,maxAgents:MODELS[id]?.maxAgents,quality:MODELS[id]?.quality})),
      activeSlots:[...state.activeSlots.entries()].map(([id,s])=>({slotId:id,...s})),
      chatSlots:[...state.chatSlots.entries()].map(([id,s])=>({slotId:id,...s})),
      colocGroups:[...state.colocGroups.entries()].map(([id,g])=>({groupId:id,...g})),
      queue:state.queue.map(t=>({taskId:t.taskId,score:t.score,role:t.role,repo:t.repo})),
      paused:[...state.pausedTasks.keys()],
      sessionModels:[...state.sessionModels.entries()].map(([id,s])=>({
        sessionId:id, modelId:s.modelId, surface:s.surface,
        lockedAt:s.lockedAt, lowScoreStreak:s.lowScoreStreak, lastScore:s.lastScore,
        pendingUpgrade:s.pendingUpgrade, pendingDowngrade:s.pendingDowngrade,
      })),
    });

  // ── POST /chat/request ────────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/chat/request') {
    const body = await readBody(req);
    const {messages=[], surface='chat', requestId} = body;
    const score    = computeChatScore(messages);
    const dispatch = dispatchChatModel(score);
    let slotId = null;
    if (!dispatch.fallback) {
      if (!dispatch.reuse) {
        const model=MODELS[dispatch.modelId];
        const gpus=allocateVram(model.vram);
        if (gpus) {
          await loadModel(dispatch.modelId);
          if (!state.loadedModels.has(dispatch.modelId))
            state.loadedModels.set(dispatch.modelId,{vram:model.vram,gpus,agentSlots:new Map(),loadedAt:Date.now()});
          else state.loadedModels.get(dispatch.modelId).gpus = gpus;
        }
      }
      slotId = `chat-${++slotCounter}`;
      const loaded = state.loadedModels.get(dispatch.modelId);
      if (loaded) loaded.agentSlots.set(slotId, requestId||slotId);
      state.chatSlots.set(slotId,{surface,modelId:dispatch.modelId,requestId,allocatedAt:Date.now()});
    }
    log(`/chat/request surface=${surface} score=${score} model=${dispatch.modelId} fallback=${dispatch.fallback} slot=${slotId}`);
    return json(res,200,{model:dispatch.modelId, ollamaUrl:dispatch.ollamaUrl, fallback:dispatch.fallback, slotId, score});
  }

  // ── POST /chat/fanout ─────────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/chat/fanout') {
    const body = await readBody(req);
    const {subtasks=[], surface='vscode'} = body;
    const results = await Promise.all(subtasks.map(async sub => {
      const score    = computeChatScore(sub.messages||[]);
      const dispatch = dispatchChatModel(score);
      let slotId = null;
      if (!dispatch.fallback) {
        if (!dispatch.reuse) {
          const model=MODELS[dispatch.modelId];
          const gpus=allocateVram(model.vram);
          if (gpus) {
            await loadModel(dispatch.modelId);
            if (!state.loadedModels.has(dispatch.modelId))
              state.loadedModels.set(dispatch.modelId,{vram:model.vram,gpus,agentSlots:new Map(),loadedAt:Date.now()});
          }
        }
        slotId = `fanout-${++slotCounter}`;
        const loaded=state.loadedModels.get(dispatch.modelId);
        if (loaded) loaded.agentSlots.set(slotId,sub.requestId||slotId);
        state.chatSlots.set(slotId,{surface,modelId:dispatch.modelId,requestId:sub.requestId,file:sub.file,allocatedAt:Date.now()});
      }
      log(`Fan-out slot: file=${sub.file} score=${score} model=${dispatch.modelId} slot=${slotId}`);
      return {file:sub.file, requestId:sub.requestId, model:dispatch.modelId, ollamaUrl:dispatch.ollamaUrl, fallback:dispatch.fallback, slotId, score};
    }));
    return json(res,200,{subtasks:results});
  }

  // ── POST /chat/release ────────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/chat/release') {
    const {slotId} = await readBody(req);
    const slot = state.chatSlots.get(slotId);
    if (!slot) return json(res,404,{error:'unknown chatSlot'});
    const loaded = state.loadedModels.get(slot.modelId);
    if (loaded) {
      loaded.agentSlots.delete(slotId);
      if (loaded.agentSlots.size===0&&state.mode==='AGENT_ACTIVE') {
        releaseVram(loaded.gpus,loaded.vram);
        await unloadModel(slot.modelId);
      }
    }
    state.chatSlots.delete(slotId);
    log(`🔓 chatSlot ${slotId} released (${slot.modelId}) | free=${totalFree()}GB`);
    // Releasing a human slot → may free VRAM for agents
    setImmediate(()=>tryResumeAgents().catch(()=>{}));
    return json(res,200,{ok:true,totalFree:totalFree()});
  }

  // ── POST /chat/session/lock ───────────────────────────────────────────────
  // First message of a session — chooses and locks the model
  if (req.method==='POST'&&url==='/chat/session/lock') {
    const body = await readBody(req);
    const {sessionId, surface='chat', messages=[]} = body;
    if (!sessionId) return json(res,400,{error:'sessionId required'});
    const session = await getOrCreateSession(sessionId, surface, messages);
    log(`/chat/session/lock ${sessionId} → ${session.modelId} (surface=${surface})`);
    return json(res,200,{
      sessionId,
      modelId:   session.modelId,
      ollamaUrl: session.ollamaUrl,
      fallback:  session.fallback,
      lockedAt:  session.lockedAt,
    });
  }

  // ── POST /chat/session/score ──────────────────────────────────────────────
  // Evaluates each message in session context
  // Returns action: 'ok' | 'upgrade' | 'downgrade'
  if (req.method==='POST'&&url==='/chat/session/score') {
    const body = await readBody(req);
    const {sessionId, messages=[]} = body;
    if (!sessionId) return json(res,400,{error:'sessionId required'});
    // Create session if it doesn't exist yet (tolerance)
    if (!state.sessionModels.has(sessionId)) {
      const {surface='chat'} = body;
      await getOrCreateSession(sessionId, surface, messages);
    }
    const result = await evaluateSessionMessage(sessionId, messages);
    const session = state.sessionModels.get(sessionId);
    return json(res,200,{
      ...result,
      lowScoreStreak: session?.lowScoreStreak ?? 0,
    });
  }

  // ── POST /chat/session/confirm ────────────────────────────────────────────
  // User confirms a proposed upgrade or downgrade
  if (req.method==='POST'&&url==='/chat/session/confirm') {
    const body = await readBody(req);
    const {sessionId, direction} = body; // direction: 'upgrade' | 'downgrade'
    if (!sessionId||!direction) return json(res,400,{error:'sessionId and direction required'});
    const session = state.sessionModels.get(sessionId);
    if (!session) return json(res,404,{error:'unknown session'});

    const targetModel = direction==='upgrade'
      ? session.pendingUpgrade
      : session.pendingDowngrade;

    if (!targetModel) return json(res,409,{error:'no swap awaiting confirmation'});

    const ok = await applySessionModelChange(sessionId, targetModel);
    const updated = state.sessionModels.get(sessionId);
    log(`/chat/session/confirm ${sessionId} ${direction} → ${targetModel} ok=${ok}`);
    return json(res,200,{
      ok,
      modelId:   updated?.modelId,
      ollamaUrl: updated?.ollamaUrl,
    });
  }

  // ── POST /chat/session/release ────────────────────────────────────────────
  // End of session (idle timeout or disconnect)
  if (req.method==='POST'&&url==='/chat/session/release') {
    const {sessionId} = await readBody(req);
    if (!sessionId) return json(res,400,{error:'sessionId required'});
    await releaseSession(sessionId);
    return json(res,200,{ok:true,totalFree:totalFree()});
  }

  // ── POST /enqueue ─────────────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/enqueue') {
    const body = await readBody(req);
    const {taskId,repo,issueId,role='dev',title='',issueBody='',labels=[],estimatedFiles=1,parentGroup,branch,forceScore} = body;
    if (!taskId||!repo) return json(res,400,{error:'taskId and repo required'});
    let score = forceScore!==undefined
      ? Math.max(0,Math.min(100,forceScore))
      : computeScore({title,body:issueBody,role,labels,estimatedFiles});
    if (forceScore===undefined&&state.queue.length>0) {
      const prefs=MODEL_PREFS[role]||MODEL_PREFS.dev;
      const dec=await cpuAmbiguityCheck({title,body:issueBody,role,score,queueLength:state.queue.length+1,currentModel:prefs[0],degradedModel:prefs[1]});
      if (dec==='degrade') score=Math.min(score,AMBIGUITY_ZONE_LOW-1);
      if (dec==='keep')    score=Math.max(score,AMBIGUITY_ZONE_HIGH+1);
    }
    const task={taskId,repo,issueId,role,score,title,parentGroup,branch,addedAt:Date.now()};
    state.queue.push(task);
    log(`Enqueued ${taskId} (score=${score} role=${role} repo=${repo})`);
    if (state.mode==='HUMAN_EXCLUSIVE'||state.mode==='HUMAN_ACTIVE') return json(res,202,{status:'queued',reason:'human_exclusive',score});
    await processQueue();
    const slot=[...state.activeSlots.values()].find(s=>s.taskId===taskId);
    return slot ? json(res,200,{status:'started',score,...slot}) : json(res,202,{status:'queued',reason:'vram_full',score});
  }

  // ── POST /release ─────────────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/release') {
    const {slotId} = await readBody(req);
    const slot = state.activeSlots.get(slotId);
    if (!slot) return json(res,404,{error:'unknown slot'});
    const loaded=state.loadedModels.get(slot.modelId);
    if (loaded) {
      loaded.agentSlots.delete(slotId);
      if (loaded.agentSlots.size===0){releaseVram(loaded.gpus,loaded.vram); await unloadModel(slot.modelId);}
    }
    if (slot.colocGroup) {
      const g=state.colocGroups.get(slot.colocGroup);
      if (g){g.slotIds=g.slotIds.filter(id=>id!==slotId); if(!g.slotIds.length) state.colocGroups.delete(slot.colocGroup);}
    }
    state.activeSlots.delete(slotId);
    log(`🔓 ${slotId} released (${slot.modelId}) | free=${totalFree()}GB`);
    // In shared human mode, try to resume paused tasks
    if (state.mode==='HUMAN_SHARED'||state.mode==='HUMAN_EXCLUSIVE') {
      setImmediate(()=>tryResumeAgents().catch(()=>{}));
    } else {
      await processQueue();
    }
    return json(res,200,{ok:true,totalFree:totalFree()});
  }

  // ── POST /score ───────────────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/score') {
    const body  = await readBody(req);
    const score = computeScore(body);
    const recommended=(MODEL_PREFS[body.role||'dev']||MODEL_PREFS.dev).find(m=>MODELS[m]?.minScore<=score)||'qwen3.5:4b';
    const ambiguous=score>=AMBIGUITY_ZONE_LOW&&score<=AMBIGUITY_ZONE_HIGH;
    return json(res,200,{score,recommended,quality:MODELS[recommended]?.quality,ambiguous});
  }

  // ── POST /human/heartbeat ─────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/human/heartbeat') {
    const {surface} = await readBody(req);
    if (!['chat','vscode'].includes(surface)) return json(res,400,{error:'surface: chat or vscode'});
    return json(res,200, await handleHeartbeat(surface));
  }

  // ── POST /human/token-end ─────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/human/token-end') {
    const switched=handleTokenEnd();
    // After each token, try to resume agents if VRAM available
    if (state.mode==='HUMAN_SHARED'||state.mode==='HUMAN_EXCLUSIVE') {
      setImmediate(()=>tryResumeAgents().catch(()=>{}));
    }
    return json(res,200,{switched,activeSurface:state.activeSurface,pendingSurface:state.pendingSurface,mode:state.mode,vramFree:totalFree()});
  }

  // ── POST /human/active compat ─────────────────────────────────────────────
  if (req.method==='POST'&&url==='/human/active') {
    return json(res,200,{mode:state.mode, ...await handleHeartbeat('chat')});
  }

  // ── POST /human/inactive ──────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/human/inactive') {
    await resumeAgentsFull();
    return json(res,200,{mode:state.mode});
  }

  json(res,404,{error:'not found'});
});

server.listen(PORT,'0.0.0.0',()=>{
  log(`GPU Scheduler v5 :${PORT} | ${totalVram()}GB VRAM | chat=${HUMAN_IDLE_CHAT_MS/60000}min agents=${HUMAN_IDLE_AGENT_MS/60000}min`);
  log(`Modes: AGENT_ACTIVE → HUMAN_SHARED (cohabitation) → HUMAN_EXCLUSIVE (no room left) | MIN_AGENT_VRAM=${MIN_AGENT_VRAM}GB`);
  log(`Models: ${Object.entries(MODELS).map(([id,m])=>`${id}(${m.vram}GB q=${m.quality}×${m.maxAgents})`).join(' | ')}`);
});

process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT', ()=>server.close(()=>process.exit(0)));
