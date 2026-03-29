/**
 * stream-proxy.ts — Intelligent Ollama proxy for openclaw-chat and cdw-vscode
 *
 * Role:
 *   1. Before each /api/chat request -> calls /chat/request on the scheduler
 *   2. Streams the response to the client
 *   3. Pings /human/heartbeat on each SSE chunk -> resets idle timer
 *   4. Pings /human/token-end at end of each chunk -> switches surface if preemption pending
 *   5. CPU fallback -> X-Fallback-CPU + X-Fallback-Model headers
 *   6. POST /cancel-and-wait -> cancels CPU stream, waits for GPU
 *   7. VSCode fan-out: parallelizable patterns -> /chat/fanout -> fan-in
 */

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Config ──────────────────────────────────────────────────────────────────

const SURFACE = process.env.SURFACE ?? 'chat';
const SCHEDULER_URL = process.env.SCHEDULER_URL ?? 'http://openclaw-agent:7070';
const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? '11435');
const SESSION_IDLE_MS = parseInt(process.env.HUMAN_IDLE_CHAT_MS ?? '900000');

// ── Sequential keywords — disable fan-out ───────────────────────────────────

const SEQ_KW = [
  'sequentially', 'in order', 'first', 'then next', 'step by step',
  'one by one', 'first then',
];

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

const FILE_RE = [
  /`([^`]+\.(?:js|ts|py|vue|jsx|tsx|css|scss|go|rs|java|php|rb|c|cpp|h))`/g,
  /"([^"]+\.(?:js|ts|py|vue|jsx|tsx|css|scss|go|rs|java|php|rb|c|cpp|h))"/g,
  /\b([\w/.-]+\.(?:js|ts|py|vue|jsx|tsx|css|scss|go|rs|java|php|rb|c|cpp|h))\b/g,
];

const log = (msg: string, lvl = 'INFO') =>
  console.log(`[stream-proxy/${SURFACE}] ${new Date().toISOString()} [${lvl}] ${msg}`);

// ── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: string | Array<{ text?: string }>;
}

interface FanoutSubtask {
  file: string;
  requestId: string;
  messages: ChatMessage[];
}

interface SchedulerSlot {
  model: string;
  ollamaUrl: string;
  fallback: boolean;
  slotId: string | null;
}

// ── Scheduler ───────────────────────────────────────────────────────────────

const schedulerReq = (method: string, path: string, body: unknown = null): Promise<Record<string, unknown>> =>
  new Promise(resolve => {
    try {
      const url = new URL(path, SCHEDULER_URL);
      const payload = body ? JSON.stringify(body) : null;
      const opts = {
        method, hostname: url.hostname, port: url.port ? parseInt(url.port) : 7070, path: url.pathname,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() } : {},
      };
      const req = httpRequest(opts, res => {
        let d = '';
        res.on('data', (c: string) => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d) as Record<string, unknown>); } catch { resolve({}); } });
      });
      req.on('error', () => resolve({}));
      if (payload) req.write(payload);
      req.end();
    } catch { resolve({}); }
  });

const heartbeat = () => { schedulerReq('POST', '/human/heartbeat', { surface: SURFACE }).catch(() => { /* silent */ }); };
const tokenEnd = () => { schedulerReq('POST', '/human/token-end').catch(() => { /* silent */ }); };
const releaseSlot = (slotId: string | null) => {
  if (slotId) schedulerReq('POST', '/chat/release', { slotId }).catch(() => { /* silent */ });
};

// ── VSCode fan-out detection ────────────────────────────────────────────────

const detectFanout = (messages: ChatMessage[]): FanoutSubtask[] | null => {
  if (SURFACE !== 'vscode') return null;

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return null;

  const content = typeof lastUser.content === 'string'
    ? lastUser.content
    : (lastUser.content ?? []).map(c => c.text ?? '').join(' ');

  if (SEQ_KW.some(kw => content.toLowerCase().includes(kw))) return null;
  if (!PARALLEL_RE.some(p => p.test(content))) return null;

  const files = new Set<string>();
  for (const pattern of FILE_RE) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) files.add(m[1]!);
  }

  if (files.size < 2) return null;
  log(`Fan-out detected: ${files.size} files -> ${[...files].join(', ')}`);

  return [...files].map((file, i) => ({
    file,
    requestId: `fanout-req-${Date.now()}-${i}`,
    messages: [
      ...messages.slice(0, -1),
      {
        role: 'user',
        content: content.replace(
          /these\s+\d+\s+files?|each\s+file|all(\s+the)?\s+files?/gi,
          `the file \`${file}\``,
        ),
      },
    ],
  }));
};

// ── Proxy stream to Ollama ──────────────────────────────────────────────────

const proxyStream = ({ ollamaUrl, model, reqBody, clientRes, isFallback, slotId }: {
  ollamaUrl: string; model: string; reqBody: Record<string, unknown>;
  clientRes: ServerResponse; isFallback: boolean; slotId: string | null;
}): Promise<void> =>
  new Promise((resolve, reject) => {
    const target = new URL('/api/chat', ollamaUrl);
    const body = JSON.stringify({ ...reqBody, model, stream: true });

    if (isFallback) {
      clientRes.setHeader('X-Fallback-CPU', 'true');
      clientRes.setHeader('X-Fallback-Model', model);
      clientRes.setHeader('X-Cancel-Wait-Url', `http://localhost:${PROXY_PORT}/cancel-and-wait`);
    }
    clientRes.setHeader('Content-Type', 'application/x-ndjson');
    clientRes.setHeader('Transfer-Encoding', 'chunked');
    if (!clientRes.headersSent) clientRes.writeHead(200);

    const opts = {
      method: 'POST', hostname: target.hostname, port: target.port ? parseInt(target.port) : 11434, path: target.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString() },
    };

    const ollamaReq = httpRequest(opts, ollamaRes => {
      ollamaRes.on('data', (chunk: Buffer) => {
        heartbeat();
        clientRes.write(chunk);
        tokenEnd();
      });
      ollamaRes.on('end', () => { releaseSlot(slotId); clientRes.end(); resolve(); });
      ollamaRes.on('error', e => { releaseSlot(slotId); reject(e); });
    });

    ollamaReq.on('error', e => { releaseSlot(slotId); reject(e); });
    ollamaReq.write(body);
    ollamaReq.end();
  });

// ── Fan-in VSCode ───────────────────────────────────────────────────────────

const handleFanout = async ({ subtasksSpec, reqBody, schedulerSlots, clientRes }: {
  subtasksSpec: FanoutSubtask[]; reqBody: Record<string, unknown>;
  schedulerSlots: SchedulerSlot[]; clientRes: ServerResponse;
}) => {
  log(`Fan-in: ${subtasksSpec.length} subtasks`);

  clientRes.setHeader('Content-Type', 'application/json');
  clientRes.setHeader('X-Fanout', 'true');
  clientRes.setHeader('X-Fanout-Count', String(subtasksSpec.length));
  if (!clientRes.headersSent) clientRes.writeHead(200);

  const results = await Promise.allSettled(
    subtasksSpec.map(async (sub, i) => {
      const slot = schedulerSlots[i]!;
      const target = new URL('/api/chat', slot.ollamaUrl);
      const options = reqBody.options as Record<string, unknown> | undefined;
      const body = JSON.stringify({
        ...reqBody,
        model: slot.model,
        stream: false,
        messages: sub.messages,
        options: slot.fallback
          ? { ...(options ?? {}), num_gpu: 0, num_predict: (options?.num_predict as number) ?? 512 }
          : (options ?? {}),
      });

      return new Promise<{ file: string; content: string }>((resolve, reject) => {
        const opts = {
          method: 'POST', hostname: target.hostname, port: target.port ? parseInt(target.port) : 11434, path: target.pathname,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString() },
        };
        const req = httpRequest(opts, res => {
          let d = '';
          res.on('data', (c: string) => d += c);
          res.on('end', () => {
            releaseSlot(slot.slotId);
            try {
              const parsed = JSON.parse(d) as Record<string, unknown>;
              const msg = parsed.message as Record<string, unknown> | undefined;
              resolve({ file: sub.file, content: (msg?.content as string) ?? '' });
            } catch { reject(new Error('Parse error')); }
          });
        });
        req.on('error', e => { releaseSlot(slot.slotId); reject(e); });
        req.write(body);
        req.end();
      });
    }),
  );

  const aggregated = results.map((r, i) => {
    const file = subtasksSpec[i]!.file;
    if (r.status === 'fulfilled') return `### \`${file}\`\n\n${r.value.content}`;
    return `### \`${file}\`\n\nError: ${r.reason?.message ?? 'unknown'}`;
  }).join('\n\n---\n\n');

  const ok = results.filter(r => r.status === 'fulfilled').length;
  log(`Fan-in complete: ${ok}/${results.length} succeeded`);

  clientRes.end(JSON.stringify({
    model: reqBody.model, done: true, fanout: true, subtasks: subtasksSpec.length,
    message: { role: 'assistant', content: aggregated },
  }));
};

// ── Local session state ─────────────────────────────────────────────────────

let localSessionId: string | null = null;
let sessionIdleTimer: ReturnType<typeof setTimeout> | null = null;

const resetSessionIdle = () => {
  if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
  sessionIdleTimer = setTimeout(async () => {
    if (localSessionId) {
      log(`Session ${localSessionId} expired (idle) — release`);
      await schedulerReq('POST', '/chat/session/release', { sessionId: localSessionId });
      localSessionId = null;
    }
  }, SESSION_IDLE_MS);
};

const getOrInitSessionId = (): string => {
  if (!localSessionId)
    localSessionId = `${SURFACE}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return localSessionId;
};

const sendSessionProposal = (clientRes: ServerResponse, proposal: Record<string, unknown>) => {
  const chunk = JSON.stringify({
    type: 'session_proposal',
    action: proposal.action,
    targetModel: proposal.targetModel,
    message: proposal.message,
    sessionId: localSessionId,
  });
  if (!clientRes.headersSent) {
    clientRes.setHeader('Content-Type', 'application/x-ndjson');
    clientRes.setHeader('Transfer-Encoding', 'chunked');
    clientRes.writeHead(200);
  }
  clientRes.write(chunk + '\n');
};

// ── HTTP Helpers ────────────────────────────────────────────────────────────

const readBody = (req: IncomingMessage): Promise<Record<string, unknown> | null> =>
  new Promise(resolve => {
    let d = '';
    req.on('data', (c: string) => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d) as Record<string, unknown>); } catch { resolve(null); } });
  });

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const urlPath = req.url?.split('?')[0] ?? '';

  if (req.method === 'GET' && urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, surface: SURFACE, sessionId: localSessionId }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/session/confirm') {
    const body = await readBody(req);
    const direction = body?.direction as string | undefined;
    if (!localSessionId || !direction) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId or direction missing' }));
      return;
    }
    const result = await schedulerReq('POST', '/chat/session/confirm', { sessionId: localSessionId, direction });
    log(`Session confirm ${direction} -> ${result.modelId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && urlPath === '/cancel-and-wait') {
    const body = await readBody(req);
    const requestId = body?.requestId as string | undefined;
    const messages = body?.messages as ChatMessage[] | undefined;
    if (!requestId || !messages) { res.writeHead(400); res.end(); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.writeHead(200);
    res.write('data: {"status":"waiting"}\n\n');
    const pollId = setInterval(async () => {
      const dispatch = await schedulerReq('POST', '/chat/request', { messages, surface: SURFACE, requestId });
      if (!dispatch.fallback && dispatch.model) {
        clearInterval(pollId);
        res.write(`data: ${JSON.stringify({ status: 'ready', model: dispatch.model, slotId: dispatch.slotId })}\n\n`);
        res.end();
      }
    }, 5000);
    req.on('close', () => clearInterval(pollId));
    return;
  }

  // Transparent proxy for non /api/chat routes
  if (req.method !== 'POST' || urlPath !== '/api/chat') {
    const body = await readBody(req);
    const payload = body ? JSON.stringify(body) : null;
    const gpuUrl = process.env.OLLAMA_GPU_URL ?? 'http://ollama:11434';
    const target = new URL(urlPath, gpuUrl);
    const opts = {
      method: req.method!, hostname: target.hostname, port: target.port ? parseInt(target.port) : 11434, path: target.pathname,
      headers: { ...req.headers, host: target.host },
    };
    if (payload) (opts.headers as Record<string, unknown>)['content-length'] = Buffer.byteLength(payload);
    const proxyReq = httpRequest(opts, proxyRes => {
      res.writeHead(proxyRes.statusCode!, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => { res.writeHead(502); res.end(); });
    if (payload) proxyReq.write(payload);
    proxyReq.end();
    return;
  }

  // ── POST /api/chat ────────────────────────────────────────────────────────
  const reqBody = await readBody(req);
  if (!reqBody) { res.writeHead(400); res.end(); return; }

  heartbeat();
  resetSessionIdle();

  const messages = (reqBody.messages ?? []) as ChatMessage[];
  const sessionId = getOrInitSessionId();

  // Fan-out VSCode
  if (SURFACE === 'vscode') {
    const subtasks = detectFanout(messages);
    if (subtasks && subtasks.length >= 2) {
      const fanoutRes = await schedulerReq('POST', '/chat/fanout', {
        subtasks: subtasks.map(s => ({ file: s.file, requestId: s.requestId, messages: s.messages })),
        surface: SURFACE,
      });
      const fanoutSubtasks = fanoutRes?.subtasks as SchedulerSlot[] | undefined;
      if (fanoutSubtasks?.length === subtasks.length) {
        await handleFanout({ subtasksSpec: subtasks, reqBody, schedulerSlots: fanoutSubtasks, clientRes: res });
        return;
      }
      log('Fan-out: scheduler unavailable -> normal mode', 'WARN');
    }
  }

  // Session lock or score
  const statusRes = await schedulerReq('GET', '/status');
  const knownSessions = (statusRes?.sessionModels ?? []) as Array<Record<string, unknown>>;
  const isNewSession = !knownSessions.find(s => s.sessionId === sessionId);

  let sessionInfo: Record<string, unknown>;
  if (isNewSession) {
    sessionInfo = await schedulerReq('POST', '/chat/session/lock', { sessionId, surface: SURFACE, messages });
    log(`Session locked: ${sessionId} -> ${sessionInfo?.modelId}`);
  } else {
    sessionInfo = await schedulerReq('POST', '/chat/session/score', { sessionId, surface: SURFACE, messages });
    if (sessionInfo?.action === 'upgrade' || sessionInfo?.action === 'downgrade') {
      log(`Proposal ${sessionInfo.action} -> ${sessionInfo.targetModel} (streak)`);
      sendSessionProposal(res, sessionInfo);
    }
  }

  const model = (sessionInfo?.modelId as string) ?? (reqBody.model as string) ?? 'qwen3.5:4b';
  const ollamaUrl = (sessionInfo?.ollamaUrl as string) ?? 'http://ollama:11434';
  const isFallback = !!sessionInfo?.fallback;

  const slotRes = await schedulerReq('POST', '/chat/request', {
    messages, surface: SURFACE,
    requestId: `req-${Date.now()}`,
    forceModel: model,
  });
  const slotId = (slotRes?.slotId as string) ?? null;

  log(`Request: model=${model} fallback=${isFallback} slotId=${slotId} session=${sessionId}`);

  const options = reqBody.options as Record<string, unknown> | undefined;
  const finalBody = isFallback
    ? { ...reqBody, options: { ...(options ?? {}), num_gpu: 0, num_predict: (options?.num_predict as number) ?? 512 } }
    : reqBody;

  await proxyStream({ ollamaUrl, model, reqBody: finalBody, clientRes: res, isFallback, slotId })
    .catch(e => {
      log(`Proxy error: ${(e as Error).message}`, 'WARN');
      if (!res.headersSent) { res.writeHead(502); res.end(); }
    });
});

// ── Startup ─────────────────────────────────────────────────────────────────

server.listen(PROXY_PORT, '0.0.0.0', () => {
  log(`Started on :${PROXY_PORT}`);
  log(`Surface: ${SURFACE} | Scheduler: ${SCHEDULER_URL}`);
  log('Session lock: first message -> model locked for session duration');
  if (SURFACE === 'vscode') log('Automatic fan-out enabled (parallelizable patterns)');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
