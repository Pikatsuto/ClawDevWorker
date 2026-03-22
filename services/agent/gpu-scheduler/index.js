#!/usr/bin/env node
/**
 * gpu-scheduler v5 — cohabitation HUMAN_SHARED + HUMAN_EXCLUSIVE
 *
 * RTX 2080 Ti : 11GB (gpu0)
 * GTX 1660    :  6GB (gpu1)
 * Total       : 17GB
 *
 * API :
 *   GET  /health
 *   GET  /status
 *   POST /enqueue                  → tâche agent autonome
 *   POST /release                  → libère slot agent
 *   POST /score                    → calcule score sans enqueuer
 *   POST /chat/request             → dispatch modèle pour chat/vscode
 *   POST /chat/fanout              → enqueue N sous-tâches VSCode parallèles
 *   POST /chat/release             → libère slot chat
 *   POST /chat/session/lock        → lock le modèle pour la durée de la session
 *   POST /chat/session/score       → évalue un message, retourne conseil upgrade/downgrade
 *   POST /chat/session/confirm     → confirme upgrade ou downgrade proposé
 *   POST /chat/session/release     → libère la session (idle ou déconnexion)
 *   POST /human/heartbeat          → reset timer, gère préemption surface
 *   POST /human/token-end          → bascule surface si préemption en attente
 *   POST /human/active             → compat ancienne API
 *   POST /human/inactive           → reprise agents
 *
 * Modes :
 *   AGENT_ACTIVE    → agents tournent librement, toute la VRAM dispo
 *   HUMAN_SHARED    → humain actif, agents continuent SI la VRAM restante le permet
 *                     Si l'humain prend plus de place → pause les agents qui débordent
 *                     Quand la VRAM se libère → reprend les agents pausés (incrémantal)
 *   HUMAN_EXCLUSIVE → humain a pris toute la VRAM, plus de place pour aucun agent
 *                     Agents pausés jusqu'à libération
 *   (HUMAN_ACTIVE gardé comme alias de HUMAN_EXCLUSIVE pour compat)
 *
 * Transition :
 *   heartbeat reçu → HUMAN_SHARED
 *     → recalcule VRAM après session humaine
 *     → si free < MIN_AGENT_VRAM → HUMAN_EXCLUSIVE, pause tout
 *     → sinon → HUMAN_SHARED, agents en cours continuent
 *   Chaque token humain → recalcule → reprend agents si de la place s'est libérée
 *   idle 15min → AGENT_ACTIVE, tout reprend
 *
 * Session model lock :
 *   - Premier message → score algo → CPU tranche si zone grise → modèle locké keep_alive=-1
 *   - score > session.minScore + UPGRADE_THRESHOLD → propose upgrade (chat/vscode)
 *                                                  → upgrade silencieux (agent AGENT_ACTIVE)
 *   - score < session.minScore - DOWNGRADE_THRESHOLD → lowScoreStreak++
 *     → streak >= 3 → propose downgrade (chat/vscode) / downgrade silencieux (agent)
 *   - HUMAN_EXCLUSIVE → agents : rien ne bouge
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

// ── Catalogue modèles — configurable via .env ─────────────────────────────────
// MODEL_COMPLEX   → score ≥ 70  (défaut: qwen3.5:27b-q3_k_m, 14GB)
// MODEL_STANDARD  → score 30-70 (défaut: qwen3.5:9b,          5GB)
// MODEL_LIGHT     → score 10-30 (défaut: qwen3.5:4b,          3GB)
// MODEL_TRIVIAL   → score < 10  (défaut: qwen3.5:2b,          2GB)
// MODEL_CPU       → CPU only    (défaut: qwen3.5:0.8b,        0GB)
//
// VRAM_COMPLEX / VRAM_STANDARD / VRAM_LIGHT / VRAM_TRIVIAL permettent
// d'ajuster si le modèle choisi a une empreinte différente.

const M_COMPLEX  = process.env.MODEL_COMPLEX  || 'qwen3.5:27b-q3_k_m';
const M_STANDARD = process.env.MODEL_STANDARD || 'qwen3.5:9b';
const M_LIGHT    = process.env.MODEL_LIGHT    || 'qwen3.5:4b';
const M_TRIVIAL  = process.env.MODEL_TRIVIAL  || 'qwen3.5:2b';
const M_CPU      = process.env.MODEL_CPU      || 'qwen3.5:0.8b';

const VRAM_COMPLEX  = parseInt(process.env.VRAM_COMPLEX  || '14');
const VRAM_STANDARD = parseInt(process.env.VRAM_STANDARD || '5');
const VRAM_LIGHT    = parseInt(process.env.VRAM_LIGHT    || '3');
const VRAM_TRIVIAL  = parseInt(process.env.VRAM_TRIVIAL  || '2');

// Catalogue construit dynamiquement au démarrage
const MODELS = {
  [M_COMPLEX]:  { vram: VRAM_COMPLEX,  quality:10, maxAgents:1, thinking:true,  minScore:70 },
  [M_STANDARD]: { vram: VRAM_STANDARD, quality: 7, maxAgents:3, thinking:true,  minScore:30 },
  [M_LIGHT]:    { vram: VRAM_LIGHT,    quality: 4, maxAgents:4, thinking:true,  minScore:10 },
  [M_TRIVIAL]:  { vram: VRAM_TRIVIAL,  quality: 2, maxAgents:6, thinking:true,  minScore: 0 },
  [M_CPU]:      { vram: 0,             quality: 1, maxAgents:8, thinking:false, minScore: 0 },
};

// Tous les rôles spécialistes partagent la même préférence de modèles
const SPECIALIST_ROLES = [
  'architect','frontend','backend','fullstack','devops','security','qa','doc',
  'marketing','design','product','bizdev',
];

const MODEL_PREFS = {
  chat:  [M_COMPLEX, M_STANDARD, M_LIGHT, M_TRIVIAL],
  audit: [M_STANDARD, M_LIGHT, M_TRIVIAL],
};
// Injecter tous les rôles spécialistes avec la même liste
for (const role of SPECIALIST_ROLES) {
  MODEL_PREFS[role] = [M_COMPLEX, M_STANDARD, M_LIGHT, M_TRIVIAL];
}
// Compat legacy
MODEL_PREFS.dev = MODEL_PREFS.frontend;
MODEL_PREFS.qa  = [M_STANDARD, M_LIGHT, M_TRIVIAL];

// Chemins upgrade/downgrade — construits dynamiquement
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
  critical:['security','sécurité','auth','migration','database','base de données','architecture','refactor','refacto','system','deploy','infrastructure','performance','breaking','cve','vulnerability'],
  high:    ['feature','fonctionnalité','api','integration','multi','async','concurrent','cache','algorithm','algorithme','search','indexing'],
  medium:  ['bug','fix','error','erreur','crash','regression','test','validation'],
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

  // Sessions chat/vscode — modèle locké pour la durée de la session
  // sessionId → {
  //   modelId, surface, lockedAt,
  //   lowScoreStreak,   // nb de messages consécutifs sous le seuil
  //   pendingDowngrade, // modèle proposé au downgrade, attend confirmation
  //   pendingUpgrade,   // modèle proposé à l'upgrade, attend confirmation
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
  if ([/^(c'est quoi|qu'est-ce|what is|how do|comment faire|pourquoi)/i,/\?$/,/^(merci|ok|yes|oui|non|no)\b/i]
      .some(p=>p.test(content.trim()))) score-=15;
  if (/\b(refactor|rewrite|réécrire|implément|implement|créer|create|génère|generate)\b/i.test(text)) score+=15;
  if (/\b(fichier|file|classe|class|module|composant|component)\b/i.test(text)) score+=8;
  return Math.max(0, Math.min(100, score));
}

// ── Dispatch chat/vscode ──────────────────────────────────────────────────────
// Priorité :
//   1. Modèle chargé avec slot libre (qualitatif d'abord)
//   2. n+1 déjà chargé avec slot libre — opportuniste
//   3. Charger le modèle idéal si VRAM suffisante
//   4. Fallback CPU

function dispatchChatModel(score) {
  const prefs   = MODEL_PREFS.chat;
  const idealId = prefs.find(m => MODELS[m]?.minScore<=score) || prefs[prefs.length-1];
  const idealQ  = MODELS[idealId]?.quality || 0;

  // 1+2 : slot libre sur modèle déjà chargé
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
    log(`Chat dispatch: réutilisation ${best.modelId} (score=${score})`);
    return { modelId:best.modelId, ollamaUrl:OLLAMA_URL, fallback:false, reuse:true };
  }

  // 3 : charger modèle idéal
  const idealModel = MODELS[idealId];
  if (idealModel && totalFree()>=idealModel.vram) {
    log(`Chat dispatch: chargement ${idealId} (score=${score}, libre=${totalFree()}GB)`);
    return { modelId:idealId, ollamaUrl:OLLAMA_URL, fallback:false, reuse:false };
  }

  // 4 : fallback CPU
  log(`Chat dispatch: fallback CPU (score=${score}, libre=${totalFree()}GB)`, 'WARN');
  return { modelId:'qwen3.5:0.8b', ollamaUrl:OLLAMA_CPU_URL, fallback:true, reuse:false };
}

// ── Session model — lock + streak upgrade/downgrade ───────────────────────────
//
// Logique identique pour chat, vscode et agents autonomes.
// La différence est dans l'action :
//   chat/vscode  → retourne une proposition, attend confirmation humaine
//   agent        → applique silencieusement si AGENT_ACTIVE

/**
 * Crée ou retourne une session pour un sessionId.
 * Au premier appel : choisit le modèle via dispatchChatModel, le locke.
 */
async function getOrCreateSession(sessionId, surface, messages) {
  if (state.sessionModels.has(sessionId)) return state.sessionModels.get(sessionId);

  const score    = computeChatScore(messages);
  const dispatch = dispatchChatModel(score);

  // Charge le modèle si nécessaire et alloue VRAM
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
  log(`Session ${sessionId} lockée sur ${dispatch.modelId} (score=${score} surface=${surface})`);
  return session;
}

/**
 * Évalue un message dans le contexte d'une session existante.
 * Retourne l'action à prendre :
 *   { action: 'ok',        modelId, ollamaUrl }          → continuer normalement
 *   { action: 'upgrade',   modelId, targetModel, vramDelta, reason }
 *   { action: 'downgrade', modelId, targetModel, vramFreed, reason }
 *
 * Pour les agents (surface='agent') : applique directement si AGENT_ACTIVE.
 */
async function evaluateSessionMessage(sessionId, messages) {
  const session = state.sessionModels.get(sessionId);
  if (!session) return { action: 'no_session' };

  const score    = computeChatScore(messages);
  const model    = MODELS[session.modelId];
  const minScore = model?.minScore ?? 0;

  session.lastScore = score;

  // ── Upgrade : score explose ───────────────────────────────────────────────
  if (score > minScore + UPGRADE_THRESHOLD) {
    session.lowScoreStreak = 0;
    const targetModel = MODEL_UPGRADE[session.modelId];
    if (!targetModel) return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };

    const targetVram = MODELS[targetModel]?.vram ?? 0;
    const currentVram = model?.vram ?? 0;
    const vramDelta = targetVram - currentVram;
    const hasFreeVram = totalFree() >= vramDelta;
    const reason = `Score ${score} dépasse le seuil du modèle actuel (${session.modelId}, minScore=${minScore}) de +${score - minScore - UPGRADE_THRESHOLD} points`;

    if (session.surface === 'agent') {
      // Agent autonome → upgrade silencieux sauf si humain exclusif
      if (state.mode !== 'HUMAN_EXCLUSIVE' && state.mode !== 'HUMAN_ACTIVE' && hasFreeVram) {
        await applySessionModelChange(sessionId, targetModel);
        log(`Session ${sessionId} upgradée silencieusement → ${targetModel} (score=${score})`);
        return { action:'ok', modelId:targetModel, ollamaUrl:OLLAMA_URL, silent:true };
      }
      return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };
    }

    // Chat/vscode → proposition (pas de confirmation en attente déjà)
    if (!session.pendingUpgrade) {
      session.pendingUpgrade = targetModel;
      const vramInfo = hasFreeVram
        ? `${vramDelta}GB supplémentaires disponibles`
        : `manque ${vramDelta - totalFree()}GB — des agents seront mis en pause`;
      return {
        action: 'upgrade',
        modelId: session.modelId,
        targetModel,
        ollamaUrl: session.ollamaUrl,
        vramDelta,
        hasFreeVram,
        reason,
        message: `⬆️ Cette tâche mérite un modèle plus puissant.\n` +
                 `Passer à **${targetModel}** (${vramInfo}).\n` +
                 `Réponds \`/upgrade\` pour confirmer ou continue avec le modèle actuel.`,
      };
    }
    return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };
  }

  // ── Downgrade : score bas sur N messages consécutifs ─────────────────────
  if (score < minScore - DOWNGRADE_THRESHOLD) {
    session.lowScoreStreak++;

    if (session.lowScoreStreak >= DOWNGRADE_STREAK_MAX) {
      session.lowScoreStreak = 0; // reset — attend confirmation avant de recompter
      const targetModel = MODEL_DOWNGRADE[session.modelId];
      if (!targetModel) return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };

      const vramFreed = (model?.vram ?? 0) - (MODELS[targetModel]?.vram ?? 0);

      if (session.surface === 'agent') {
        // Agent autonome → downgrade silencieux sauf si humain exclusif
        if (state.mode !== 'HUMAN_EXCLUSIVE' && state.mode !== 'HUMAN_ACTIVE') {
          await applySessionModelChange(sessionId, targetModel);
          log(`Session ${sessionId} downgradée silencieusement → ${targetModel} (streak=${DOWNGRADE_STREAK_MAX})`);
          return { action:'ok', modelId:targetModel, ollamaUrl:OLLAMA_URL, silent:true };
        }
        return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };
      }

      // Chat/vscode → proposition
      if (!session.pendingDowngrade) {
        session.pendingDowngrade = targetModel;
        return {
          action: 'downgrade',
          modelId: session.modelId,
          targetModel,
          ollamaUrl: session.ollamaUrl,
          vramFreed,
          message: `💡 Les ${DOWNGRADE_STREAK_MAX} derniers messages ne nécessitent pas **${session.modelId}**.\n` +
                   `Passer à **${targetModel}** libérerait **${vramFreed}GB** de VRAM pour tes agents.\n` +
                   `Réponds \`/downgrade\` pour confirmer ou continue normalement.`,
        };
      }
    }
    // Streak en cours mais pas encore atteint → continue normalement
    return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };
  }

  // ── Score normal → reset streak ───────────────────────────────────────────
  session.lowScoreStreak = 0;
  session.pendingUpgrade   = null; // annule proposition upgrade si score revient normal
  return { action:'ok', modelId:session.modelId, ollamaUrl:session.ollamaUrl };
}

/**
 * Applique un changement de modèle sur une session (upgrade ou downgrade).
 * Libère l'ancien modèle si plus aucun slot ne l'utilise, charge le nouveau.
 */
async function applySessionModelChange(sessionId, targetModelId) {
  const session = state.sessionModels.get(sessionId);
  if (!session) return false;

  const oldModelId = session.modelId;
  const targetModel = MODELS[targetModelId];
  if (!targetModel) return false;

  // Libère l'ancien modèle si aucun autre slot ne l'utilise
  const loaded = state.loadedModels.get(oldModelId);
  if (loaded) {
    // Retire le slot de session de l'ancien modèle
    for (const [k, v] of loaded.agentSlots) {
      if (v === sessionId) { loaded.agentSlots.delete(k); break; }
    }
    if (loaded.agentSlots.size === 0) {
      releaseVram(loaded.gpus, loaded.vram);
      await unloadModel(oldModelId);
    }
  }

  // Charge le nouveau modèle
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
 * Libère une session et décharge le modèle si plus aucun utilisateur.
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
  log(`Session ${sessionId} libérée (${session.modelId})`);
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
    `Rôle: ${role} | Score: ${score}/100`,
    `Modèle actuel: ${currentModel} (q=${currentQ}/10) → dégradé: ${degradedModel} (q=${degradedQ}/10)`,
    `Queue: ${queueLength} tâches`,
    `Dégrader pour libérer un slot GPU supplémentaire ? YES ou NO.`
  ].filter(Boolean).join('\n');
  try {
    const res = await ollamaReq('POST','/api/generate',{
      model:'qwen3.5:0.8b', prompt, stream:false, keep_alive:0,
      options:{num_gpu:0, num_predict:5, temperature:0}
    }, OLLAMA_CPU_URL);
    const decision = (res.response||'').trim().toUpperCase().startsWith('YES')?'degrade':'keep';
    log(`Ambiguïté CPU → ${decision}`);
    return decision;
  } catch(e) { log(`Ambiguïté CPU échouée: ${e.message}`,'WARN'); return null; }
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

  // Routing MODEL_<ROLE> depuis .env — override prioritaire sur MODEL_PREFS
  // Ex: MODEL_MARKETING=mistral:7b → utilisé en premier pour le gate marketing
  function getPrefsForRole(role) {
    const envKey   = `MODEL_${role.toUpperCase()}`;
    const envModel = process.env[envKey];
    const base     = MODEL_PREFS[role] || MODEL_PREFS.dev;
    if (envModel && !base.includes(envModel)) {
      // Injecter le modèle spécifique en tête + l'ajouter au catalogue si inconnu
      if (!MODELS[envModel]) {
        MODELS[envModel] = { vram: 5, quality: 7, maxAgents: 3, thinking: true, minScore: 0 };
        log(`MODEL_${role.toUpperCase()}=${envModel} chargé depuis .env (vram estimée 5GB)`);
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
    log(`Plan: ${bestPlan.length}/${queueSize} tâches | score=${bestScore.toFixed(3)} | ${summary}`);
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
  log(`Chargement: ${modelId}`);
  try {
    await ollamaReq('POST','/api/generate',{model:modelId,keep_alive:-1,prompt:'',options:{num_parallel:MODELS[modelId]?.maxAgents||2}});
    log(`${modelId} prêt (max ${MODELS[modelId]?.maxAgents} agents)`);
  } catch(e){log(`Erreur load ${modelId}: ${e.message}`,'WARN');}
}

async function unloadModel(modelId) {
  try {
    await ollamaReq('POST','/api/generate',{model:modelId,keep_alive:0,prompt:''});
    state.loadedModels.delete(modelId);
    log(`${modelId} déchargé`);
  } catch(e){log(`Erreur unload ${modelId}: ${e.message}`,'WARN');}
}

// ── Priorité humaine — cohabitation HUMAN_SHARED / HUMAN_EXCLUSIVE ───────────
//
// HUMAN_SHARED    : humain actif, agents continuent si VRAM suffisante
// HUMAN_EXCLUSIVE : humain a pris toute la place, agents pausés
// AGENT_ACTIVE    : humain idle, agents libres
//
// Alias : HUMAN_ACTIVE = HUMAN_EXCLUSIVE (compat)

/**
 * Calcule la VRAM consommée par les slots humains (chat/vscode).
 * = somme des VRAM des modèles chargés uniquement pour des slots chat.
 */
function humanVramUsed() {
  let used = 0;
  for (const [modelId, loaded] of state.loadedModels) {
    // Un modèle est "humain" si au moins un de ses slots est un slot chat
    const hasChatSlot = [...state.chatSlots.values()].some(s => s.modelId === modelId);
    if (hasChatSlot) used += loaded.vram;
  }
  return used;
}

/**
 * VRAM réellement disponible pour les agents autonomes
 * = totalFree() - marge de sécurité pour les éventuels chargements humains
 */
function agentFreeVram() {
  return Math.max(0, totalFree());
}

/**
 * Pause uniquement les agents qui n'ont plus assez de VRAM.
 * Laisse tourner ceux qui sont déjà alloués si la VRAM est suffisante.
 * Appelé quand on passe en HUMAN_SHARED ou HUMAN_EXCLUSIVE.
 */
async function pauseAgentsIfNeeded() {
  const free = agentFreeVram();
  log(`🧑 HUMAN_SHARED — VRAM libre=${free}GB MIN_AGENT=${MIN_AGENT_VRAM}GB`);

  if (free >= MIN_AGENT_VRAM) {
    // Assez de place — les agents actifs peuvent rester
    // Bloquer seulement les nouvelles allocations depuis la queue
    log('Agents actifs maintenus (VRAM suffisante)');
    return;
  }

  // Pas assez de place — passer en HUMAN_EXCLUSIVE, pauser tout
  log('⚠️ VRAM insuffisante pour cohabitation → HUMAN_EXCLUSIVE','WARN');
  state.mode = 'HUMAN_EXCLUSIVE';

  for (const [slotId, slot] of state.activeSlots) {
    state.pausedTasks.set(slot.taskId, { slotId, ...slot, pausedAt: Date.now() });
    notify(ORCHESTRATOR_URL, 'pause', { taskId: slot.taskId });
  }
  state.activeSlots.clear();

  // Décharger les modèles agents (garder les modèles humains chargés)
  for (const [modelId, loaded] of state.loadedModels) {
    const hasChatSlot = [...state.chatSlots.values()].some(s => s.modelId === modelId);
    if (!hasChatSlot) {
      releaseVram(loaded.gpus, loaded.vram);
      await unloadModel(modelId);
    }
  }
  // Nettoyer les loadedModels agents
  for (const modelId of [...state.loadedModels.keys()]) {
    const hasChatSlot = [...state.chatSlots.values()].some(s => s.modelId === modelId);
    if (!hasChatSlot) state.loadedModels.delete(modelId);
  }

  log(`HUMAN_EXCLUSIVE — libre=${totalFree()}GB`);
}

/**
 * Tente de reprendre des agents pausés si de la VRAM s'est libérée.
 * Appelé après chaque release de slot humain (token-end, session/release).
 * Incrémental : reprend autant d'agents que la VRAM permet.
 */
async function tryResumeAgents() {
  if (state.mode === 'AGENT_ACTIVE') return;
  if (!state.pausedTasks.size) return;

  const free = agentFreeVram();
  if (free < MIN_AGENT_VRAM) {
    log(`tryResumeAgents: VRAM ${free}GB < ${MIN_AGENT_VRAM}GB → pas de reprise`);
    return;
  }

  log(`↩️ VRAM ${free}GB disponible — tentative reprise agents pausés`);

  // Passer en HUMAN_SHARED si on était HUMAN_EXCLUSIVE
  if (state.mode === 'HUMAN_EXCLUSIVE' || state.mode === 'HUMAN_ACTIVE') {
    state.mode = 'HUMAN_SHARED';
  }

  // Remettre les tâches pausées dans la queue pour processQueue()
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
 * Reprise complète — humain idle depuis HUMAN_IDLE_CHAT_MS.
 */
async function resumeAgentsFull() {
  if (state.mode === 'AGENT_ACTIVE') return;
  log(`🤖 AGENT_ACTIVE — humain idle ${HUMAN_IDLE_CHAT_MS/60000}min`);
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
      log(`Humain idle ${HUMAN_IDLE_CHAT_MS/60000}min → AGENT_ACTIVE`);
      await resumeAgentsFull();
    }
  }, HUMAN_IDLE_CHAT_MS);
}

async function handleHeartbeat(surface) {
  state.humanLastSeen = Date.now();

  // Gestion préemption entre surfaces (chat ↔ vscode)
  if (state.activeSurface && state.activeSurface !== surface) {
    if (state.waitingForTokenEnd) {
      state.pendingSurface = surface;
      return { ok: true, surface, preempting: true, waiting: true };
    }
    log(`Surface ${surface} préempte ${state.activeSurface} (attend fin token)`, 'WARN');
    state.waitingForTokenEnd = true;
    state.pendingSurface     = surface;
    return { ok: true, surface, preempting: true, waiting: true };
  }

  state.activeSurface = surface;

  // Première fois que l'humain arrive (depuis AGENT_ACTIVE)
  if (state.mode === 'AGENT_ACTIVE') {
    state.mode = 'HUMAN_SHARED';
    log(`🧑 ${surface} actif → HUMAN_SHARED`);
    await pauseAgentsIfNeeded();
  }
  // Si déjà en mode humain, recalculer à chaque heartbeat (token)
  // pour reprendre des agents si de la VRAM s'est libérée entre temps
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
  log(`Bascule surface ${prev} → ${state.activeSurface}`);
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
  // HUMAN_EXCLUSIVE (plus de VRAM dispo) ou HUMAN_ACTIVE (compat) → bloquer
  if (state.mode==='HUMAN_EXCLUSIVE'||state.mode==='HUMAN_ACTIVE') return;
  if (!state.queue.length) return;

  // HUMAN_SHARED → n'allouer que si la VRAM restante le permet
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
        if (!gpus){log(`VRAM insuffisante pour ${allocation.modelId}`,'WARN'); continue;}
        await loadModel(allocation.modelId);
        loaded={vram:model.vram,gpus,agentSlots:new Map(),loadedAt:Date.now()};
        state.loadedModels.set(allocation.modelId,loaded);
      }
      const model=MODELS[allocation.modelId];
      if (loaded.agentSlots.size>=model.maxAgents){log(`${allocation.modelId} saturé`,'WARN'); continue;}
      const slotId=`slot-${++slotCounter}`;
      loaded.agentSlots.set(slotId,task.taskId);
      const colocGroupId=task.parentGroup||findOrCreateColocGroup(task);
      if (colocGroupId){const g=state.colocGroups.get(colocGroupId); if(g){g.slotIds.push(slotId); g.modelId=g.modelId||allocation.modelId;}}
      state.activeSlots.set(slotId,{taskId:task.taskId,modelId:allocation.modelId,role:task.role,score:task.score,repo:task.repo,issueId:task.issueId,branch:task.branch,colocGroup:colocGroupId,reservedAt:Date.now()});
      state.queue.splice(taskIdx,1);
      const used=loaded.agentSlots.size;
      log(`✅ ${slotId}: ${task.taskId} → ${allocation.modelId} [score=${task.score} q=${model.quality} agents=${used}/${model.maxAgents} ${allocation.reuse?'réutilisé':'nouveau'} libre=${totalFree()}GB${colocGroupId?` coloc=${colocGroupId}`:''}]`);
      notify(ORCHESTRATOR_URL,'slot-ready',{taskId:task.taskId,slotId,modelId:allocation.modelId,gpus:loaded.gpus,colocGroup:colocGroupId,agentIndex:used-1});
    } catch(e){log(`Erreur allocation ${task.taskId}: ${e.message}`,'WARN');}
  }
  log(`VRAM: ${totalFree()}/${totalVram()}GB libre | actifs=${state.activeSlots.size} | queue=${state.queue.length}`);
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
    if (!slot) return json(res,404,{error:'chatSlot inconnu'});
    const loaded = state.loadedModels.get(slot.modelId);
    if (loaded) {
      loaded.agentSlots.delete(slotId);
      if (loaded.agentSlots.size===0&&state.mode==='AGENT_ACTIVE') {
        releaseVram(loaded.gpus,loaded.vram);
        await unloadModel(slot.modelId);
      }
    }
    state.chatSlots.delete(slotId);
    log(`🔓 chatSlot ${slotId} libéré (${slot.modelId}) | libre=${totalFree()}GB`);
    // Libération d'un slot humain → peut libérer de la VRAM pour les agents
    setImmediate(()=>tryResumeAgents().catch(()=>{}));
    return json(res,200,{ok:true,totalFree:totalFree()});
  }

  // ── POST /chat/session/lock ───────────────────────────────────────────────
  // Premier message d'une session — choisit et locke le modèle
  if (req.method==='POST'&&url==='/chat/session/lock') {
    const body = await readBody(req);
    const {sessionId, surface='chat', messages=[]} = body;
    if (!sessionId) return json(res,400,{error:'sessionId requis'});
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
  // Évalue chaque message dans le contexte de la session
  // Retourne action: 'ok' | 'upgrade' | 'downgrade'
  if (req.method==='POST'&&url==='/chat/session/score') {
    const body = await readBody(req);
    const {sessionId, messages=[]} = body;
    if (!sessionId) return json(res,400,{error:'sessionId requis'});
    // Crée la session si elle n'existe pas encore (tolérance)
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
  // L'utilisateur confirme un upgrade ou downgrade proposé
  if (req.method==='POST'&&url==='/chat/session/confirm') {
    const body = await readBody(req);
    const {sessionId, direction} = body; // direction: 'upgrade' | 'downgrade'
    if (!sessionId||!direction) return json(res,400,{error:'sessionId et direction requis'});
    const session = state.sessionModels.get(sessionId);
    if (!session) return json(res,404,{error:'session inconnue'});

    const targetModel = direction==='upgrade'
      ? session.pendingUpgrade
      : session.pendingDowngrade;

    if (!targetModel) return json(res,409,{error:'aucun swap en attente de confirmation'});

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
  // Fin de session (idle timeout ou déconnexion)
  if (req.method==='POST'&&url==='/chat/session/release') {
    const {sessionId} = await readBody(req);
    if (!sessionId) return json(res,400,{error:'sessionId requis'});
    await releaseSession(sessionId);
    return json(res,200,{ok:true,totalFree:totalFree()});
  }

  // ── POST /enqueue ─────────────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/enqueue') {
    const body = await readBody(req);
    const {taskId,repo,issueId,role='dev',title='',issueBody='',labels=[],estimatedFiles=1,parentGroup,branch,forceScore} = body;
    if (!taskId||!repo) return json(res,400,{error:'taskId et repo requis'});
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
    if (!slot) return json(res,404,{error:'slot inconnu'});
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
    log(`🔓 ${slotId} libéré (${slot.modelId}) | libre=${totalFree()}GB`);
    // En mode humain partagé, tenter de reprendre des tâches pausées
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
    if (!['chat','vscode'].includes(surface)) return json(res,400,{error:'surface: chat ou vscode'});
    return json(res,200, await handleHeartbeat(surface));
  }

  // ── POST /human/token-end ─────────────────────────────────────────────────
  if (req.method==='POST'&&url==='/human/token-end') {
    const switched=handleTokenEnd();
    // Après chaque token, tenter de reprendre des agents si VRAM disponible
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
  log(`Modes: AGENT_ACTIVE → HUMAN_SHARED (cohabitation) → HUMAN_EXCLUSIVE (plus de place) | MIN_AGENT_VRAM=${MIN_AGENT_VRAM}GB`);
  log(`Modèles: ${Object.entries(MODELS).map(([id,m])=>`${id}(${m.vram}GB q=${m.quality}×${m.maxAgents})`).join(' | ')}`);
});

process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT', ()=>server.close(()=>process.exit(0)));
