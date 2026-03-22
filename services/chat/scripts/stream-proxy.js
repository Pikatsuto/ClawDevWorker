#!/usr/bin/env node
/**
 * stream-proxy.js — Proxy Ollama intelligent pour openclaw-chat et cdw-vscode
 *
 * Rôle :
 *   1. Avant chaque requête /api/chat → appelle /chat/request sur le scheduler
 *      qui sélectionne le meilleur modèle disponible selon le score de complexité
 *      (réutilisation slot > n+1 opportuniste > chargement > fallback CPU)
 *   2. Stream la réponse vers le client
 *   3. Ping /human/heartbeat à chaque chunk SSE reçu → reset timer idle 15min
 *   4. Ping /human/token-end à la fin de chaque chunk → bascule surface si préemption
 *   5. Si fallback CPU → headers X-Fallback-CPU + X-Fallback-Model pour l'UI
 *   6. POST /cancel-and-wait → annule le stream CPU en cours, met la requête
 *      en attente du prochain slot GPU, répond via SSE quand dispo
 *   7. VSCode fan-out : détecte les patterns parallélisables, appelle /chat/fanout
 *      sur le scheduler, exécute les sous-tâches en parallèle, agrège en fan-in
 *
 * Variables d'env :
 *   SURFACE            — 'chat' | 'vscode'
 *   SCHEDULER_URL      — http://openclaw-agent:7070
 *   PROXY_PORT         — 11435
 *   CPU_FALLBACK_MODEL — qwen3.5:0.8b
 */

'use strict';

const http = require('http');

const SURFACE            = process.env.SURFACE            || 'chat';
const SCHEDULER_URL      = process.env.SCHEDULER_URL      || 'http://openclaw-agent:7070';
const PROXY_PORT         = parseInt(process.env.PROXY_PORT || '11435');
const CPU_FALLBACK_MODEL = process.env.CPU_FALLBACK_MODEL  || 'qwen3.5:0.8b';

// ── Mots-clés séquentiels — désactivent le fan-out ───────────────────────────
const SEQ_KW = [
  "séquentiellement","dans l'ordre","d'abord","puis ensuite","étape par étape",
  "step by step","sequentially","in order","one by one","un par un",
  "d'abord puis","first then",
];

// ── Patterns parallélisables ──────────────────────────────────────────────────
const PARALLEL_RE = [
  /refactorise?\s+(ces\s+)?\d+\s+fichiers?/i,
  /pour\s+(chaque|chacun|tous\s+les)\s+fichiers?/i,
  /analyse?\s+(ces|les)\s+(\d+|plusieurs)\s+fichiers?/i,
  /génère?\s+des\s+tests\s+pour/i,
  /ajoute?\s+des\s+commentaires?\s+(dans|sur|pour)/i,
  /applique?\s+.+\s+à\s+(chaque|tous)/i,
  /for\s+each\s+(of\s+these\s+)?files?/i,
  /in\s+each\s+of\s+these/i,
  /update\s+(all|each|every)\s+files?/i,
];

// ── File patterns pour extraction ─────────────────────────────────────────────
const FILE_RE = [
  /`([^`]+\.(?:js|ts|py|vue|jsx|tsx|css|scss|go|rs|java|php|rb|c|cpp|h))`/g,
  /"([^"]+\.(?:js|ts|py|vue|jsx|tsx|css|scss|go|rs|java|php|rb|c|cpp|h))"/g,
  /\b([\w/.-]+\.(?:js|ts|py|vue|jsx|tsx|css|scss|go|rs|java|php|rb|c|cpp|h))\b/g,
];

const log = (msg, lvl='INFO') =>
  console.log(`[stream-proxy/${SURFACE}] ${new Date().toISOString()} [${lvl}] ${msg}`);

// ── Scheduler ─────────────────────────────────────────────────────────────────

function schedulerReq(method, path, body=null) {
  return new Promise(resolve => {
    try {
      const url     = new URL(path, SCHEDULER_URL);
      const payload = body ? JSON.stringify(body) : null;
      const opts    = {
        method, hostname:url.hostname, port:url.port||7070, path:url.pathname,
        headers: payload ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} : {},
      };
      const req = http.request(opts, res=>{
        let d=''; res.on('data',c=>d+=c);
        res.on('end',()=>{try{resolve(JSON.parse(d));}catch{resolve({});}});
      });
      req.on('error',()=>resolve({}));
      if (payload) req.write(payload);
      req.end();
    } catch { resolve({}); }
  });
}

// fire-and-forget pour les heartbeats dans le chemin chaud du stream
function heartbeat()   { schedulerReq('POST','/human/heartbeat',{surface:SURFACE}).catch(()=>{}); }
function tokenEnd()    { schedulerReq('POST','/human/token-end').catch(()=>{}); }
function releaseSlot(slotId) {
  if (slotId) schedulerReq('POST','/chat/release',{slotId}).catch(()=>{});
}

// ── Détection fan-out VSCode ──────────────────────────────────────────────────

function detectFanout(messages) {
  if (SURFACE !== 'vscode') return null;

  const lastUser = [...messages].reverse().find(m=>m.role==='user');
  if (!lastUser) return null;

  const content = typeof lastUser.content==='string'
    ? lastUser.content
    : (lastUser.content||[]).map(c=>c.text||'').join(' ');

  // Séquentiel explicite → pas de fan-out
  if (SEQ_KW.some(kw=>content.toLowerCase().includes(kw))) return null;

  // Pattern parallélisable ?
  if (!PARALLEL_RE.some(p=>p.test(content))) return null;

  // Extraction des fichiers mentionnés
  const files = new Set();
  for (const pattern of FILE_RE) {
    pattern.lastIndex = 0;
    let m;
    while ((m=pattern.exec(content))!==null) files.add(m[1]);
  }

  if (files.size < 2) return null;
  log(`Fan-out détecté: ${files.size} fichiers → ${[...files].join(', ')}`);

  return [...files].map((file,i) => ({
    file,
    requestId: `fanout-req-${Date.now()}-${i}`,
    messages: [
      ...messages.slice(0,-1),
      { role:'user', content: content.replace(
          /ces\s+\d+\s+fichiers?|chaque\s+fichier|tous\s+les\s+fichiers?/gi,
          `le fichier \`${file}\``
        )
      },
    ],
  }));
}

// ── Proxy stream vers Ollama ──────────────────────────────────────────────────

function proxyStream({ollamaUrl, model, reqBody, clientRes, isFallback, slotId}) {
  return new Promise((resolve, reject) => {
    const target  = new URL('/api/chat', ollamaUrl);
    const body    = JSON.stringify({...reqBody, model, stream:true});

    if (isFallback) {
      clientRes.setHeader('X-Fallback-CPU',   'true');
      clientRes.setHeader('X-Fallback-Model', model);
      // Le client peut appeler POST /cancel-and-wait pour annuler et attendre GPU
      clientRes.setHeader('X-Cancel-Wait-Url', `http://localhost:${PROXY_PORT}/cancel-and-wait`);
    }
    clientRes.setHeader('Content-Type','application/x-ndjson');
    clientRes.setHeader('Transfer-Encoding','chunked');
    if (!clientRes.headersSent) clientRes.writeHead(200);

    const opts = {
      method:'POST', hostname:target.hostname, port:target.port||11434, path:target.pathname,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
    };

    const ollamaReq = http.request(opts, ollamaRes => {
      ollamaRes.on('data', chunk => {
        heartbeat();          // reset timer idle à chaque token
        clientRes.write(chunk);
        tokenEnd();           // bascule surface si préemption en attente
      });
      ollamaRes.on('end',  () => { releaseSlot(slotId); clientRes.end(); resolve(); });
      ollamaRes.on('error', e => { releaseSlot(slotId); reject(e); });
    });

    ollamaReq.on('error', e => { releaseSlot(slotId); reject(e); });
    ollamaReq.write(body);
    ollamaReq.end();
  });
}

// ── Fan-in VSCode ─────────────────────────────────────────────────────────────

async function handleFanout({subtasksSpec, reqBody, schedulerSlots, clientRes}) {
  log(`Fan-in: ${subtasksSpec.length} sous-tâches`);

  clientRes.setHeader('Content-Type','application/json');
  clientRes.setHeader('X-Fanout','true');
  clientRes.setHeader('X-Fanout-Count', String(subtasksSpec.length));
  if (!clientRes.headersSent) clientRes.writeHead(200);

  // Exécute toutes les sous-tâches en parallèle (non-stream pour agrégation)
  const results = await Promise.allSettled(
    subtasksSpec.map(async (sub, i) => {
      const slot     = schedulerSlots[i];
      const target   = new URL('/api/chat', slot.ollamaUrl);
      const body     = JSON.stringify({
        ...reqBody,
        model:  slot.model,
        stream: false,
        messages: sub.messages,
        options: slot.fallback
          ? {...(reqBody.options||{}), num_gpu:0, num_predict:reqBody.options?.num_predict||512}
          : (reqBody.options||{}),
      });

      return new Promise((resolve, reject) => {
        const opts = {
          method:'POST', hostname:target.hostname, port:target.port||11434, path:target.pathname,
          headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
        };
        const req = http.request(opts, res=>{
          let d=''; res.on('data',c=>d+=c);
          res.on('end',()=>{
            releaseSlot(slot.slotId);
            try { resolve({file:sub.file, content:JSON.parse(d).message?.content||''}); }
            catch { reject(new Error('Parse error')); }
          });
        });
        req.on('error', e=>{releaseSlot(slot.slotId); reject(e);});
        req.write(body); req.end();
      });
    })
  );

  const aggregated = results.map((r,i) => {
    const file = subtasksSpec[i].file;
    if (r.status==='fulfilled') return `### \`${file}\`\n\n${r.value.content}`;
    return `### \`${file}\`\n\n❌ Erreur: ${r.reason?.message||'inconnue'}`;
  }).join('\n\n---\n\n');

  const ok = results.filter(r=>r.status==='fulfilled').length;
  log(`Fan-in terminé: ${ok}/${results.length} succès`);

  clientRes.end(JSON.stringify({
    model: reqBody.model, done:true, fanout:true, subtasks:subtasksSpec.length,
    message:{ role:'assistant', content:aggregated },
  }));
}

// ── Pending GPU-wait ──────────────────────────────────────────────────────────
const pendingGpuWait = new Map();

// ── State session locale ──────────────────────────────────────────────────────
let localSessionId   = null;
const SESSION_IDLE_MS = parseInt(process.env.HUMAN_IDLE_CHAT_MS || '900000');
let sessionIdleTimer  = null;

function resetSessionIdle() {
  clearTimeout(sessionIdleTimer);
  sessionIdleTimer = setTimeout(async () => {
    if (localSessionId) {
      log(`Session ${localSessionId} expirée (idle) — release`);
      await schedulerReq('POST','/chat/session/release',{sessionId:localSessionId});
      localSessionId = null;
    }
  }, SESSION_IDLE_MS);
}

function getOrInitSessionId() {
  if (!localSessionId)
    localSessionId = `${SURFACE}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  return localSessionId;
}

// Injecte une proposition upgrade/downgrade comme chunk NDJSON spécial
// OpenClaw/cpu-status skill intercepte type='session_proposal' et affiche le bandeau
function sendSessionProposal(clientRes, proposal) {
  const chunk = JSON.stringify({
    type:        'session_proposal',
    action:       proposal.action,
    targetModel:  proposal.targetModel,
    message:      proposal.message,
    sessionId:    localSessionId,
  });
  if (!clientRes.headersSent) {
    clientRes.setHeader('Content-Type','application/x-ndjson');
    clientRes.setHeader('Transfer-Encoding','chunked');
    clientRes.writeHead(200);
  }
  clientRes.write(chunk + '\n');
}

// ── Serveur HTTP ──────────────────────────────────────────────────────────────

const server = http.createServer(async(req, res) => {
  const urlPath = req.url.split('?')[0];

  // GET /health
  if (req.method==='GET'&&urlPath==='/health') {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, surface:SURFACE, sessionId:localSessionId, pendingGpuWait:pendingGpuWait.size}));
    return;
  }

  // POST /session/confirm — confirmation upgrade ou downgrade par l'utilisateur
  if (req.method==='POST'&&urlPath==='/session/confirm') {
    const body = await readBody(req);
    const {direction} = body; // 'upgrade' | 'downgrade'
    if (!localSessionId||!direction) {
      res.writeHead(400,'Content-Type','application/json');
      res.end(JSON.stringify({error:'sessionId ou direction manquant'}));
      return;
    }
    const result = await schedulerReq('POST','/chat/session/confirm',{sessionId:localSessionId, direction});
    log(`Session confirm ${direction} → ${result.modelId}`);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(result));
    return;
  }

  // POST /cancel-and-wait
  if (req.method==='POST'&&urlPath==='/cancel-and-wait') {
    const body = await readBody(req);
    const {requestId, messages} = body;
    if (!requestId||!messages) { res.writeHead(400); res.end(); return; }
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.writeHead(200);
    res.write('data: {"status":"waiting"}\n\n');
    const pollId = setInterval(async()=>{
      const dispatch = await schedulerReq('POST','/chat/request',{messages, surface:SURFACE, requestId});
      if (!dispatch.fallback && dispatch.model) {
        clearInterval(pollId);
        res.write(`data: ${JSON.stringify({status:'ready', model:dispatch.model, slotId:dispatch.slotId})}\n\n`);
        res.end();
      }
    }, 5000);
    req.on('close',()=>clearInterval(pollId));
    return;
  }

  // Proxy transparent pour toutes les routes sauf /api/chat
  if (req.method!=='POST'||urlPath!=='/api/chat') {
    const body    = await readBody(req);
    const payload = body ? JSON.stringify(body) : null;
    const status  = await schedulerReq('GET','/status');
    const gpuUrl  = status?.totalFree !== undefined
      ? (process.env.OLLAMA_GPU_URL || 'http://ollama:11434')
      : 'http://ollama:11434';
    const target  = new URL(urlPath, gpuUrl);
    const opts    = {
      method:req.method, hostname:target.hostname, port:target.port||11434, path:target.pathname,
      headers:{...req.headers, host:target.host},
    };
    if (payload) opts.headers['content-length']=Buffer.byteLength(payload);
    const proxyReq = http.request(opts, proxyRes=>{
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error',()=>{res.writeHead(502); res.end();});
    if (payload) proxyReq.write(payload);
    proxyReq.end();
    return;
  }

  // ── POST /api/chat ─────────────────────────────────────────────────────────
  const reqBody = await readBody(req);
  if (!reqBody) { res.writeHead(400); res.end(); return; }

  heartbeat();
  resetSessionIdle();

  const messages  = reqBody.messages || [];
  const sessionId = getOrInitSessionId();

  // ── Fan-out VSCode ──────────────────────────────────────────────────────
  if (SURFACE==='vscode') {
    const subtasks = detectFanout(messages);
    if (subtasks && subtasks.length>=2) {
      const fanoutRes = await schedulerReq('POST','/chat/fanout',{
        subtasks: subtasks.map(s=>({file:s.file, requestId:s.requestId, messages:s.messages})),
        surface: SURFACE,
      });
      if (fanoutRes?.subtasks?.length===subtasks.length) {
        await handleFanout({subtasksSpec:subtasks, reqBody, schedulerSlots:fanoutRes.subtasks, clientRes:res});
        return;
      }
      log('Fan-out: scheduler indisponible → mode normal','WARN');
    }
  }

  // ── Session lock (premier message) ou score + streak (suivants) ────────────
  const statusRes     = await schedulerReq('GET','/status');
  const knownSessions = statusRes?.sessionModels || [];
  const isNewSession  = !knownSessions.find(s=>s.sessionId===sessionId);

  let sessionInfo;
  if (isNewSession) {
    // Premier message → lock le modèle pour la session
    sessionInfo = await schedulerReq('POST','/chat/session/lock',{sessionId, surface:SURFACE, messages});
    log(`Session lockée: ${sessionId} → ${sessionInfo?.modelId}`);
  } else {
    // Messages suivants → évaluation streak upgrade/downgrade
    sessionInfo = await schedulerReq('POST','/chat/session/score',{sessionId, surface:SURFACE, messages});
    // Proposition → chunk spécial avant le stream, stream continue avec modèle actuel
    if (sessionInfo?.action==='upgrade'||sessionInfo?.action==='downgrade') {
      log(`Proposition ${sessionInfo.action} → ${sessionInfo.targetModel} (streak)`);
      sendSessionProposal(res, sessionInfo);
    }
  }

  // Dispatch : alloue un slot sur le modèle déjà locké par la session
  const model     = sessionInfo?.modelId   || reqBody.model || 'qwen3.5:4b';
  const ollamaUrl = sessionInfo?.ollamaUrl || 'http://ollama:11434';
  const isFallback= !!sessionInfo?.fallback;

  // Alloue le slot chat (libéré à la fin du stream)
  const slotRes = await schedulerReq('POST','/chat/request',{
    messages, surface:SURFACE,
    requestId:  `req-${Date.now()}`,
    forceModel: model,         // scheduler utilise ce modèle, pas recalcul
  });
  const slotId = slotRes?.slotId || null;

  log(`Requête: model=${model} fallback=${isFallback} slotId=${slotId} session=${sessionId}`);

  const finalBody = isFallback
    ? {...reqBody, options:{...(reqBody.options||{}), num_gpu:0, num_predict:reqBody.options?.num_predict||512}}
    : reqBody;

  await proxyStream({ollamaUrl, model, reqBody:finalBody, clientRes:res, isFallback, slotId})
    .catch(e => {
      log(`Erreur proxy: ${e.message}`,'WARN');
      if (!res.headersSent) { res.writeHead(502); res.end(); }
    });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(resolve=>{
    let d=''; req.on('data',c=>d+=c);
    req.on('end',()=>{try{resolve(JSON.parse(d));}catch{resolve(null);}});
  });
}

// ── Démarrage ─────────────────────────────────────────────────────────────────

server.listen(PROXY_PORT,'0.0.0.0',()=>{
  log(`Démarré sur :${PROXY_PORT}`);
  log(`Surface: ${SURFACE} | Scheduler: ${SCHEDULER_URL}`);
  log(`Session lock: premier message → modèle locké pour la durée de la session`);
  log(`Streak: upgrade proposé si score > minScore+${process.env.UPGRADE_THRESHOLD||30}, downgrade après 3 messages bas`);
  if (SURFACE==='vscode') log('Fan-out automatique activé (patterns parallélisables)');
});

process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT', ()=>server.close(()=>process.exit(0)));
