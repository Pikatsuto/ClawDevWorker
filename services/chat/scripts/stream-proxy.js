#!/usr/bin/env node
/**
 * stream-proxy.js — Intelligent Ollama proxy for openclaw-chat and cdw-vscode
 *
 * Role:
 *   1. Before each /api/chat request → calls /chat/request on the scheduler
 *      which selects the best available model based on the complexity score
 *      (slot reuse > opportunistic n+1 > loading > CPU fallback)
 *   2. Streams the response to the client
 *   3. Pings /human/heartbeat on each SSE chunk received → resets 15min idle timer
 *   4. Pings /human/token-end at the end of each chunk → switches surface if preemption pending
 *   5. If CPU fallback → X-Fallback-CPU + X-Fallback-Model headers for the UI
 *   6. POST /cancel-and-wait → cancels the current CPU stream, puts the request
 *      on hold for the next GPU slot, responds via SSE when available
 *   7. VSCode fan-out: detects parallelizable patterns, calls /chat/fanout
 *      on the scheduler, executes subtasks in parallel, aggregates in fan-in
 *
 * Environment variables:
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

// ── Sequential keywords — disable fan-out ────────────────────────────────────
const SEQ_KW = [
  "sequentially","in order","first","then next","step by step",
  "step by step","sequentially","in order","one by one","one by one",
  "first then","first then",
];

// ── Parallelizable patterns ──────────────────────────────────────────────────
const PARALLEL_RE = [
  /refactor\s+(these\s+)?\d+\s+files?/i,
  /for\s+(each|every|all(\s+the)?)\s+files?/i,
  /analyze?\s+(these|the)\s+(\d+|several)\s+files?/i,
  /generate\s+tests\s+for/i,
  /add\s+comments?\s+(in|on|for)/i,
  /apply\s+.+\s+to\s+(each|all)/i,
  /for\s+each\s+(of\s+these\s+)?files?/i,
  /in\s+each\s+of\s+these/i,
  /update\s+(all|each|every)\s+files?/i,
];

// ── File patterns for extraction ─────────────────────────────────────────────
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

// fire-and-forget for heartbeats in the hot path of the stream
function heartbeat()   { schedulerReq('POST','/human/heartbeat',{surface:SURFACE}).catch(()=>{}); }
function tokenEnd()    { schedulerReq('POST','/human/token-end').catch(()=>{}); }
function releaseSlot(slotId) {
  if (slotId) schedulerReq('POST','/chat/release',{slotId}).catch(()=>{});
}

// ── VSCode fan-out detection ─────────────────────────────────────────────────

function detectFanout(messages) {
  if (SURFACE !== 'vscode') return null;

  const lastUser = [...messages].reverse().find(m=>m.role==='user');
  if (!lastUser) return null;

  const content = typeof lastUser.content==='string'
    ? lastUser.content
    : (lastUser.content||[]).map(c=>c.text||'').join(' ');

  // Explicit sequential → no fan-out
  if (SEQ_KW.some(kw=>content.toLowerCase().includes(kw))) return null;

  // Parallelizable pattern?
  if (!PARALLEL_RE.some(p=>p.test(content))) return null;

  // Extract mentioned files
  const files = new Set();
  for (const pattern of FILE_RE) {
    pattern.lastIndex = 0;
    let m;
    while ((m=pattern.exec(content))!==null) files.add(m[1]);
  }

  if (files.size < 2) return null;
  log(`Fan-out detected: ${files.size} files → ${[...files].join(', ')}`);

  return [...files].map((file,i) => ({
    file,
    requestId: `fanout-req-${Date.now()}-${i}`,
    messages: [
      ...messages.slice(0,-1),
      { role:'user', content: content.replace(
          /these\s+\d+\s+files?|each\s+file|all(\s+the)?\s+files?/gi,
          `the file \`${file}\``
        )
      },
    ],
  }));
}

// ── Proxy stream to Ollama ───────────────────────────────────────────────────

function proxyStream({ollamaUrl, model, reqBody, clientRes, isFallback, slotId}) {
  return new Promise((resolve, reject) => {
    const target  = new URL('/api/chat', ollamaUrl);
    const body    = JSON.stringify({...reqBody, model, stream:true});

    if (isFallback) {
      clientRes.setHeader('X-Fallback-CPU',   'true');
      clientRes.setHeader('X-Fallback-Model', model);
      // The client can call POST /cancel-and-wait to cancel and wait for GPU
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
        heartbeat();          // reset idle timer on each token
        clientRes.write(chunk);
        tokenEnd();           // switch surface if preemption pending
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
  log(`Fan-in: ${subtasksSpec.length} subtasks`);

  clientRes.setHeader('Content-Type','application/json');
  clientRes.setHeader('X-Fanout','true');
  clientRes.setHeader('X-Fanout-Count', String(subtasksSpec.length));
  if (!clientRes.headersSent) clientRes.writeHead(200);

  // Execute all subtasks in parallel (non-stream for aggregation)
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
    return `### \`${file}\`\n\n❌ Error: ${r.reason?.message||'unknown'}`;
  }).join('\n\n---\n\n');

  const ok = results.filter(r=>r.status==='fulfilled').length;
  log(`Fan-in complete: ${ok}/${results.length} succeeded`);

  clientRes.end(JSON.stringify({
    model: reqBody.model, done:true, fanout:true, subtasks:subtasksSpec.length,
    message:{ role:'assistant', content:aggregated },
  }));
}

// ── Pending GPU-wait ──────────────────────────────────────────────────────────
const pendingGpuWait = new Map();

// ── Local session state ──────────────────────────────────────────────────────
let localSessionId   = null;
const SESSION_IDLE_MS = parseInt(process.env.HUMAN_IDLE_CHAT_MS || '900000');
let sessionIdleTimer  = null;

function resetSessionIdle() {
  clearTimeout(sessionIdleTimer);
  sessionIdleTimer = setTimeout(async () => {
    if (localSessionId) {
      log(`Session ${localSessionId} expired (idle) — release`);
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

// Inject an upgrade/downgrade proposal as a special NDJSON chunk
// OpenClaw/cpu-status skill intercepts type='session_proposal' and displays the banner
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

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async(req, res) => {
  const urlPath = req.url.split('?')[0];

  // GET /health
  if (req.method==='GET'&&urlPath==='/health') {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, surface:SURFACE, sessionId:localSessionId, pendingGpuWait:pendingGpuWait.size}));
    return;
  }

  // POST /session/confirm — user confirmation of upgrade or downgrade
  if (req.method==='POST'&&urlPath==='/session/confirm') {
    const body = await readBody(req);
    const {direction} = body; // 'upgrade' | 'downgrade'
    if (!localSessionId||!direction) {
      res.writeHead(400,'Content-Type','application/json');
      res.end(JSON.stringify({error:'sessionId or direction missing'}));
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

  // Transparent proxy for all routes except /api/chat
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
      log('Fan-out: scheduler unavailable → normal mode','WARN');
    }
  }

  // ── Session lock (first message) or score + streak (subsequent) ────────────
  const statusRes     = await schedulerReq('GET','/status');
  const knownSessions = statusRes?.sessionModels || [];
  const isNewSession  = !knownSessions.find(s=>s.sessionId===sessionId);

  let sessionInfo;
  if (isNewSession) {
    // First message → lock the model for the session
    sessionInfo = await schedulerReq('POST','/chat/session/lock',{sessionId, surface:SURFACE, messages});
    log(`Session locked: ${sessionId} → ${sessionInfo?.modelId}`);
  } else {
    // Subsequent messages → streak upgrade/downgrade evaluation
    sessionInfo = await schedulerReq('POST','/chat/session/score',{sessionId, surface:SURFACE, messages});
    // Proposal → special chunk before the stream, stream continues with current model
    if (sessionInfo?.action==='upgrade'||sessionInfo?.action==='downgrade') {
      log(`Proposal ${sessionInfo.action} → ${sessionInfo.targetModel} (streak)`);
      sendSessionProposal(res, sessionInfo);
    }
  }

  // Dispatch: allocate a slot on the model already locked by the session
  const model     = sessionInfo?.modelId   || reqBody.model || 'qwen3.5:4b';
  const ollamaUrl = sessionInfo?.ollamaUrl || 'http://ollama:11434';
  const isFallback= !!sessionInfo?.fallback;

  // Allocate the chat slot (released at the end of the stream)
  const slotRes = await schedulerReq('POST','/chat/request',{
    messages, surface:SURFACE,
    requestId:  `req-${Date.now()}`,
    forceModel: model,         // scheduler uses this model, no recalculation
  });
  const slotId = slotRes?.slotId || null;

  log(`Request: model=${model} fallback=${isFallback} slotId=${slotId} session=${sessionId}`);

  const finalBody = isFallback
    ? {...reqBody, options:{...(reqBody.options||{}), num_gpu:0, num_predict:reqBody.options?.num_predict||512}}
    : reqBody;

  await proxyStream({ollamaUrl, model, reqBody:finalBody, clientRes:res, isFallback, slotId})
    .catch(e => {
      log(`Proxy error: ${e.message}`,'WARN');
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

// ── Startup ──────────────────────────────────────────────────────────────────

server.listen(PROXY_PORT,'0.0.0.0',()=>{
  log(`Started on :${PROXY_PORT}`);
  log(`Surface: ${SURFACE} | Scheduler: ${SCHEDULER_URL}`);
  log(`Session lock: first message → model locked for the duration of the session`);
  log(`Streak: upgrade proposed if score > minScore+${process.env.UPGRADE_THRESHOLD||30}, downgrade after 3 low messages`);
  if (SURFACE==='vscode') log('Automatic fan-out enabled (parallelizable patterns)');
});

process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT', ()=>server.close(()=>process.exit(0)));
