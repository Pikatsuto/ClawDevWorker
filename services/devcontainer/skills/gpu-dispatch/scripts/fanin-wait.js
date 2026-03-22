#!/usr/bin/env node
/**
 * fanin-wait.js — Attend que tous les sub-agents aient écrit leurs résultats
 *
 * Usage :
 *   node fanin-wait.js --results-dir /tmp/dispatch-xxx/results --expected-count N --timeout 120
 *
 * Sort dès que tous les fichiers .md sont présents et non vides,
 * ou quand le timeout est atteint.
 * Exit code 0 : tous reçus. Exit code 1 : timeout (certains manquants).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const args        = process.argv.slice(2);
const resultsDir  = args[args.indexOf('--results-dir') + 1];
const expected    = parseInt(args[args.indexOf('--expected-count') + 1] || '1');
const timeoutSecs = parseInt(args[args.indexOf('--timeout') + 1] || '120');

if (!resultsDir || !fs.existsSync(resultsDir)) {
  console.error(`[fanin] Dossier résultats introuvable : ${resultsDir}`);
  process.exit(1);
}

const deadline = Date.now() + timeoutSecs * 1000;
const POLL_MS  = 1000;

function countReady() {
  return fs.readdirSync(resultsDir)
    .filter(f => f.endsWith('.md'))
    .filter(f => {
      try { return fs.statSync(path.join(resultsDir, f)).size > 0; }
      catch { return false; }
    }).length;
}

console.log(`[fanin] Attente de ${expected} résultats dans ${resultsDir} (timeout=${timeoutSecs}s)`);

const interval = setInterval(() => {
  const ready = countReady();
  console.log(`[fanin] ${ready}/${expected} résultats reçus...`);

  if (ready >= expected) {
    clearInterval(interval);
    console.log(`[fanin] ✅ Tous les résultats reçus`);
    process.exit(0);
  }

  if (Date.now() >= deadline) {
    clearInterval(interval);
    const missing = expected - ready;
    console.error(`[fanin] ⏱ Timeout — ${missing} sous-tâche(s) n'ont pas répondu`);
    // Crée des fichiers placeholder pour les tâches manquantes
    // pour que l'agrégation sache qu'il y a eu un timeout
    for (let i = ready + 1; i <= expected; i++) {
      const placeholder = path.join(resultsDir, `task-${i}-timeout.md`);
      if (!fs.existsSync(placeholder)) {
        fs.writeFileSync(placeholder, `⏱ **Timeout** — Cette sous-tâche n'a pas répondu dans les ${timeoutSecs} secondes.\n`);
      }
    }
    process.exit(1);
  }
}, POLL_MS);
