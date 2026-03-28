/**
 * fanin-wait.ts (worker) — Waits for sub-agent results from agent-fanout
 *
 * Usage:
 *   node fanin-wait.js --results-dir /tmp/fanout-xxx/results --expected-count N --timeout 300
 */

import { mkdirSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const resultsDir = args[args.indexOf('--results-dir') + 1]!;
const expected = parseInt(args[args.indexOf('--expected-count') + 1] ?? '1');
const timeoutSec = parseInt(args[args.indexOf('--timeout') + 1] ?? '300');

if (!resultsDir) {
  console.error('[fanin] --results-dir required');
  process.exit(1);
}

mkdirSync(resultsDir, { recursive: true });

const deadline = Date.now() + timeoutSec * 1000;
const POLL_MS = 2000;

const countReady = (): number => {
  try {
    return readdirSync(resultsDir)
      .filter(f => f.endsWith('.json'))
      .filter(f => {
        try { return statSync(join(resultsDir, f)).size > 0; }
        catch { return false; }
      }).length;
  } catch { return 0; }
};

console.log(`[fanin] Waiting for ${expected} results in ${resultsDir} (timeout=${timeoutSec}s)`);

const interval = setInterval(() => {
  const ready = countReady();
  console.log(`[fanin] ${ready}/${expected} sub-agents completed...`);

  if (ready >= expected) {
    clearInterval(interval);
    console.log('[fanin] All sub-agents completed');
    process.exit(0);
  }

  if (Date.now() >= deadline) {
    clearInterval(interval);
    const missing = expected - ready;
    console.error(`[fanin] Timeout — ${missing} sub-agent(s) did not respond`);
    for (let i = 1; i <= expected; i++) {
      const f = join(resultsDir, `task-${i}-timeout.json`);
      if (!existsSync(f)) {
        writeFileSync(f, JSON.stringify({ status: 'timeout', error: 'Timeout exceeded', prNumber: null, branch: '' }));
      }
    }
    process.exit(1);
  }
}, POLL_MS);
