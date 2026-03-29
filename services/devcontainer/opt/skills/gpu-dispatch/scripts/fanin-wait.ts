/**
 * fanin-wait.ts — Waits for all sub-agents to have written their results
 *
 * Usage:
 *   node fanin-wait.js --results-dir /tmp/dispatch-xxx/results --expected-count N --timeout 120
 *
 * Exits as soon as all .md files are present and non-empty,
 * or when the timeout is reached.
 * Exit code 0: all received. Exit code 1: timeout (some missing).
 */

import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const resultsDir = args[args.indexOf('--results-dir') + 1]!;
const expected = parseInt(args[args.indexOf('--expected-count') + 1] ?? '1');
const timeoutSecs = parseInt(args[args.indexOf('--timeout') + 1] ?? '120');

if (!resultsDir || !existsSync(resultsDir)) {
  console.error(`[fanin] Results directory not found: ${resultsDir}`);
  process.exit(1);
}

const deadline = Date.now() + timeoutSecs * 1000;
const POLL_MS = 1000;

const countReady = (): number =>
  readdirSync(resultsDir)
    .filter(f => f.endsWith('.md'))
    .filter(f => {
      try { return statSync(join(resultsDir, f)).size > 0; }
      catch { return false; }
    }).length;

console.log(`[fanin] Waiting for ${expected} results in ${resultsDir} (timeout=${timeoutSecs}s)`);

const interval = setInterval(() => {
  const ready = countReady();
  console.log(`[fanin] ${ready}/${expected} results received...`);

  if (ready >= expected) {
    clearInterval(interval);
    console.log('[fanin] All results received');
    process.exit(0);
  }

  if (Date.now() >= deadline) {
    clearInterval(interval);
    const missing = expected - ready;
    console.error(`[fanin] Timeout — ${missing} subtask(s) did not respond`);
    for (let i = ready + 1; i <= expected; i++) {
      const placeholder = join(resultsDir, `task-${i}-timeout.md`);
      if (!existsSync(placeholder)) {
        writeFileSync(placeholder, `**Timeout** — This subtask did not respond within ${timeoutSecs} seconds.\n`);
      }
    }
    process.exit(1);
  }
}, POLL_MS);
