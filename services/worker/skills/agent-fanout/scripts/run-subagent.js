#!/usr/bin/env node
/**
 * run-subagent.js — OpenClaw sub-agent for an agent-fanout subtask
 *
 * Required environment variables:
 *   FORGEJO_TOKEN, FORGEJO_URL, REPO, ISSUE_ID
 *   PARENT_BRANCH  — main branch of the issue
 *   SUB_BRANCH     — working branch for this sub-agent
 *   TASK_DESC      — subtask description
 *   TASK_TYPE      — feat | fix | refactor | test | docs
 *   OLLAMA_MODEL, OLLAMA_BASE_URL, OLLAMA_CPU_URL
 *   SCHEDULER_URL, SLOT_ID
 *   EPHEMERAL_DIR  — ephemeral writable directory for this sub-agent
 *   RESULT_FILE    — path where to write the JSON result
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const http = require('http');
const path = require('path');

const { loadProviders, getProviderForRepo } = require('/opt/git-provider/index.js');

const REPO           = process.env.REPO           || '';
const ISSUE_ID       = process.env.ISSUE_ID       || '';
const PARENT_BRANCH  = process.env.PARENT_BRANCH  || 'main';
const SUB_BRANCH     = process.env.SUB_BRANCH     || '';
const TASK_DESC      = process.env.TASK_DESC      || '';
const TASK_TYPE      = process.env.TASK_TYPE      || 'feat';
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   || 'qwen3.5:4b';
const OLLAMA_URL     = process.env.OLLAMA_BASE_URL|| 'http://ollama:11434';
const SCHEDULER_URL  = process.env.SCHEDULER_URL  || 'http://localhost:7070';
const SLOT_ID        = process.env.SLOT_ID        || '';
const EPHEMERAL_DIR  = process.env.EPHEMERAL_DIR  || '/tmp/subagent';
const RESULT_FILE    = process.env.RESULT_FILE    || '/tmp/result.json';

const WORKSPACE = `/workspace/${REPO.split('/')[1] || 'repo'}`;

let gitProviders, provider;
try {
  gitProviders = loadProviders();
  provider = getProviderForRepo(REPO, gitProviders);
  if (!provider) throw new Error('No provider found for ' + REPO);
} catch (e) {
  console.error(`[subagent] Git provider error: ${e.message}`);
  process.exit(1);
}

const log = msg => console.log(`[subagent/${SUB_BRANCH}] ${new Date().toISOString()} ${msg}`);

// ── Release GPU slot on exit ─────────────────────────────────────────────────
process.on('exit', () => {
  if (SLOT_ID) {
    try {
      const url  = new URL('/chat/release', SCHEDULER_URL);
      const body = JSON.stringify({ slotId: SLOT_ID });
      const req  = http.request({ method:'POST', hostname:url.hostname, port:url.port||7070,
        path:url.pathname, headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} });
      req.write(body); req.end();
    } catch {}
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function git(args, opts = {}) {
  const result = spawnSync('git', args, {
    cwd:      opts.cwd || WORKSPACE,
    encoding: 'utf8',
    timeout:  30000,
  });
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return (result.stdout || '').trim();
}

function ollamaChat(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    const url     = new URL('/api/chat', opts.baseUrl || OLLAMA_URL);
    const payload = JSON.stringify({
      model:   opts.model || OLLAMA_MODEL,
      stream:  false,
      think:   true,
      options: { num_ctx: 16384, ...(opts.options || {}) },
      messages,
    });
    const req = http.request({
      method: 'POST', hostname: url.hostname, port: url.port || 11434, path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve(j.message?.content || j.response || '');
        } catch { resolve(''); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function writeResult(data) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ ...data, branch: SUB_BRANCH }, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting sub-agent: ${SUB_BRANCH}`);
  log(`Task: ${TASK_DESC}`);
  log(`Model: ${OLLAMA_MODEL}`);

  fs.mkdirSync(EPHEMERAL_DIR, { recursive: true });

  try {
    // ── 1. Checkout the working branch ────────────────────────────────────────
    log(`Checkout ${SUB_BRANCH}...`);
    git(['fetch', 'origin', SUB_BRANCH], { allowFail: true });
    try {
      git(['checkout', SUB_BRANCH]);
    } catch {
      git(['checkout', '-b', SUB_BRANCH, `origin/${PARENT_BRANCH}`], { allowFail: true });
      git(['checkout', '-b', SUB_BRANCH]);
    }

    // ── 2. Read the repo context ──────────────────────────────────────────────
    log('Reading repo context...');
    let bmadContext = '';
    for (const dir of ['docs/bmad', '.bmad', 'bmad']) {
      const bmadPath = path.join(WORKSPACE, dir);
      if (fs.existsSync(bmadPath)) {
        const files = fs.readdirSync(bmadPath).filter(f => f.endsWith('.md'));
        bmadContext = files.map(f => fs.readFileSync(path.join(bmadPath, f), 'utf8')).join('\n\n').slice(0, 6000);
        log(`BMAD context: ${dir}/ (${bmadContext.length} chars)`);
        break;
      }
    }

    // List repo files for context
    let repoTree = '';
    try {
      repoTree = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').slice(0, 80).join('\n');
    } catch {}

    // ── 3. First Ollama call — action plan ─────────────────────────────────────
    log('Ollama call — action plan...');

    const systemPrompt = `You are an autonomous development agent specialized on a specific subtask.

Repo: ${REPO}
Parent issue: #${ISSUE_ID}
Your working branch: ${SUB_BRANCH}
Your ephemeral directory (scratchpad writes): ${EPHEMERAL_DIR}

# Git flow rules
- Atomic commits with conventional messages (feat:, fix:, refactor:, test:, docs:)
- git add ONLY the files for this change
- Push to ${SUB_BRANCH} only
- Never push to main or ${PARENT_BRANCH}
- Never merge PRs

# Security
- Read: all repo files
- File writes: only via git on ${SUB_BRANCH}
- Temp scratchpad: ${EPHEMERAL_DIR} (cleaned up afterwards)
- Network: Forgejo + Ollama only${bmadContext ? `\n\n# Project context (BMAD)\n${bmadContext}` : ''}`;

    const planMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `Subtask to implement: ${TASK_DESC}

Repo files:
${repoTree}

1. Analyze what needs to be done exactly
2. List the files to create or modify
3. Plan the atomic commits (one per logical change)
4. Say "READY" when you have your complete plan` },
    ];

    const plan = await ollamaChat(planMessages);
    log(`Plan received (${plan.length} chars)`);

    const conversationHistory = [...planMessages, { role: 'assistant', content: plan }];

    // ── 4. Implementation loop ────────────────────────────────────────────────
    // The agent iterates: analyze → code → commit → test → commit...
    // Maximum 8 rounds to avoid infinite loops
    let done       = false;
    let prNumber   = null;
    let summary    = '';
    let iterations = 0;
    const MAX_ITER = 8;

    while (!done && iterations < MAX_ITER) {
      iterations++;
      log(`Iteration ${iterations}/${MAX_ITER}...`);

      conversationHistory.push({
        role: 'user',
        content: iterations === 1
          ? `Now implement. For each file you modify:
1. Use file.write to write the content
2. Then git add + atomic git commit
3. Continue with the next file

When everything is committed, type "COMMITS_DONE" and I will create the PR.`
          : `Continue the implementation. Say "COMMITS_DONE" when all your commits are pushed.`,
      });

      const reply = await ollamaChat(conversationHistory);
      conversationHistory.push({ role: 'assistant', content: reply });
      log(`Response iteration ${iterations}: ${reply.slice(0, 200)}...`);

      // Detect if the agent has finished
      if (reply.includes('COMMITS_DONE') || reply.includes('terminé') || reply.includes('done')) {
        done    = true;
        summary = reply;
        log('Agent signals end of commits');
      }
    }

    // ── 5. Final push + atomic PR ─────────────────────────────────────────────
    log(`Push ${SUB_BRANCH}...`);
    try {
      git(['push', 'origin', SUB_BRANCH, '--set-upstream']);
    } catch (e) {
      log(`Push warning: ${e.message}`, 'WARN');
      git(['push', '-f', 'origin', SUB_BRANCH], { allowFail: true });
    }

    // Check if there are commits to push (diff with parent)
    const commitCount = git(['rev-list', '--count', `origin/${PARENT_BRANCH}..HEAD`], { allowFail: true });
    if (!commitCount || commitCount === '0') {
      log('No commits — subtask empty or already up to date');
      writeResult({ status: 'skipped', summary: 'No commits produced', prNumber: null });
      return;
    }

    log(`${commitCount} commit(s) on ${SUB_BRANCH} — creating PR...`);

    // Create the PR targeting PARENT_BRANCH (works for both Forgejo and GitHub)
    const prResult = await provider.createPR(REPO, {
      title: `${TASK_TYPE}(${SUB_BRANCH.split('/').pop()}): ${TASK_DESC.slice(0, 60)}`,
      body:  `## Subtask of issue #${ISSUE_ID}\n\n${TASK_DESC}\n\n${summary ? `## Summary\n${summary}` : ''}\n\nPart of #${ISSUE_ID}`,
      head:  SUB_BRANCH,
      base:  PARENT_BRANCH,
    });

    prNumber = prResult?.data?.number ?? null;
    log(`PR #${prNumber} created: ${SUB_BRANCH} → ${PARENT_BRANCH}`);

    // ── 6. Write the result ───────────────────────────────────────────────────
    writeResult({
      status:    'done',
      prNumber,
      summary,
      commits:   parseInt(commitCount) || 0,
      iterations,
    });

    log(`✅ Sub-agent completed — PR #${prNumber}`);

  } catch (err) {
    log(`❌ Sub-agent error: ${err.message}`);
    writeResult({ status: 'failed', error: err.message, prNumber: null });
    process.exit(1);
  }
}

main().catch(e => {
  log(`Fatal: ${e.message}`);
  writeResult({ status: 'failed', error: e.message, prNumber: null });
  process.exit(1);
});
