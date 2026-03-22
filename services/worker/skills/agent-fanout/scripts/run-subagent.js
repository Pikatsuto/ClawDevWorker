#!/usr/bin/env node
/**
 * run-subagent.js — Sub-agent OpenClaw pour une sous-tâche agent-fanout
 *
 * Variables d'env requises :
 *   FORGEJO_TOKEN, FORGEJO_URL, REPO, ISSUE_ID
 *   PARENT_BRANCH  — branche principale de l'issue
 *   SUB_BRANCH     — branche de travail de ce sub-agent
 *   TASK_DESC      — description de la sous-tâche
 *   TASK_TYPE      — feat | fix | refactor | test | docs
 *   OLLAMA_MODEL, OLLAMA_BASE_URL, OLLAMA_CPU_URL
 *   SCHEDULER_URL, SLOT_ID
 *   EPHEMERAL_DIR  — dossier éphémère en écriture pour ce sub-agent
 *   RESULT_FILE    — chemin où écrire le résultat JSON
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const http = require('http');
const path = require('path');

const FORGEJO_TOKEN  = process.env.FORGEJO_TOKEN  || '';
const FORGEJO_URL    = process.env.FORGEJO_URL    || '';
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

const log = msg => console.log(`[subagent/${SUB_BRANCH}] ${new Date().toISOString()} ${msg}`);

// ── Libération slot GPU à la sortie ──────────────────────────────────────────
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

function forgejoReq(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, FORGEJO_URL);
    const payload = body ? JSON.stringify(body) : null;
    const opts    = {
      method, hostname: url.hostname, port: url.port || 3000, path: url.pathname,
      headers: {
        'Authorization': `token ${FORGEJO_TOKEN}`,
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
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
  log(`Démarrage sub-agent : ${SUB_BRANCH}`);
  log(`Tâche : ${TASK_DESC}`);
  log(`Modèle : ${OLLAMA_MODEL}`);

  fs.mkdirSync(EPHEMERAL_DIR, { recursive: true });

  try {
    // ── 1. Checkout de la branche de travail ─────────────────────────────────
    log(`Checkout ${SUB_BRANCH}...`);
    git(['fetch', 'origin', SUB_BRANCH], { allowFail: true });
    try {
      git(['checkout', SUB_BRANCH]);
    } catch {
      git(['checkout', '-b', SUB_BRANCH, `origin/${PARENT_BRANCH}`], { allowFail: true });
      git(['checkout', '-b', SUB_BRANCH]);
    }

    // ── 2. Lire le contexte du repo ───────────────────────────────────────────
    log('Lecture du contexte repo...');
    let bmadContext = '';
    for (const dir of ['docs/bmad', '.bmad', 'bmad']) {
      const bmadPath = path.join(WORKSPACE, dir);
      if (fs.existsSync(bmadPath)) {
        const files = fs.readdirSync(bmadPath).filter(f => f.endsWith('.md'));
        bmadContext = files.map(f => fs.readFileSync(path.join(bmadPath, f), 'utf8')).join('\n\n').slice(0, 6000);
        log(`Contexte BMAD : ${dir}/ (${bmadContext.length} chars)`);
        break;
      }
    }

    // Liste des fichiers du repo pour le contexte
    let repoTree = '';
    try {
      repoTree = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').slice(0, 80).join('\n');
    } catch {}

    // ── 3. Premier appel Ollama — plan d'action ───────────────────────────────
    log('Appel Ollama — plan d\'action...');

    const systemPrompt = `Tu es un agent de développement autonome spécialisé sur une sous-tâche précise.

Repo : ${REPO}
Issue parent : #${ISSUE_ID}
Ta branche de travail : ${SUB_BRANCH}
Ton dossier éphémère (écriture scratchpad) : ${EPHEMERAL_DIR}

# Règles git flow
- Commits atomiques avec messages conventionnels (feat:, fix:, refactor:, test:, docs:)
- git add UNIQUEMENT les fichiers de ce changement
- Push sur ${SUB_BRANCH} uniquement
- Ne jamais pousser sur main ou ${PARENT_BRANCH}
- Ne jamais merger de PR

# Sécurité
- Lecture : tous les fichiers du repo
- Écriture fichiers : uniquement via git sur ${SUB_BRANCH}
- Scratchpad temp : ${EPHEMERAL_DIR} (nettoyé après)
- Réseau : Forgejo + Ollama uniquement${bmadContext ? `\n\n# Contexte projet (BMAD)\n${bmadContext}` : ''}`;

    const planMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `Sous-tâche à réaliser : ${TASK_DESC}

Fichiers du repo :
${repoTree}

1. Analyse ce qui doit être fait exactement
2. Liste les fichiers à créer ou modifier
3. Planifie les commits atomiques (un par changement logique)
4. Dis "PRÊT" quand tu as ton plan complet` },
    ];

    const plan = await ollamaChat(planMessages);
    log(`Plan reçu (${plan.length} chars)`);

    const conversationHistory = [...planMessages, { role: 'assistant', content: plan }];

    // ── 4. Boucle d'implémentation ────────────────────────────────────────────
    // L'agent itère : analyse → code → commit → test → commit...
    // Maximum 8 tours pour éviter les boucles infinies
    let done       = false;
    let prNumber   = null;
    let summary    = '';
    let iterations = 0;
    const MAX_ITER = 8;

    while (!done && iterations < MAX_ITER) {
      iterations++;
      log(`Itération ${iterations}/${MAX_ITER}...`);

      conversationHistory.push({
        role: 'user',
        content: iterations === 1
          ? `Maintenant implémente. Pour chaque fichier que tu modifies :
1. Utilise file.write pour écrire le contenu
2. Ensuite git add + git commit atomique
3. Continue avec le fichier suivant

Quand tout est commité, tape "COMMITS_DONE" et je créerai la PR.`
          : `Continue l'implémentation. Dis "COMMITS_DONE" quand tous tes commits sont poussés.`,
      });

      const reply = await ollamaChat(conversationHistory);
      conversationHistory.push({ role: 'assistant', content: reply });
      log(`Réponse iteration ${iterations} : ${reply.slice(0, 200)}...`);

      // Détecter si l'agent a terminé
      if (reply.includes('COMMITS_DONE') || reply.includes('terminé') || reply.includes('done')) {
        done    = true;
        summary = reply;
        log('Agent signale la fin des commits');
      }
    }

    // ── 5. Push final + PR atomique ───────────────────────────────────────────
    log(`Push ${SUB_BRANCH}...`);
    try {
      git(['push', 'origin', SUB_BRANCH, '--set-upstream']);
    } catch (e) {
      log(`Push warning: ${e.message}`, 'WARN');
      git(['push', '-f', 'origin', SUB_BRANCH], { allowFail: true });
    }

    // Vérifier s'il y a des commits à pousser (diff avec parent)
    const commitCount = git(['rev-list', '--count', `origin/${PARENT_BRANCH}..HEAD`], { allowFail: true });
    if (!commitCount || commitCount === '0') {
      log('Aucun commit — sous-tâche vide ou déjà à jour');
      writeResult({ status: 'skipped', summary: 'Aucun commit produit', prNumber: null });
      return;
    }

    log(`${commitCount} commit(s) sur ${SUB_BRANCH} — création PR...`);

    // Créer la PR vers PARENT_BRANCH
    const pr = await forgejoReq('POST', `/api/v1/repos/${REPO}/pulls`, {
      title: `${TASK_TYPE}(${SUB_BRANCH.split('/').pop()}): ${TASK_DESC.slice(0, 60)}`,
      body:  `## Sous-tâche de l'issue #${ISSUE_ID}\n\n${TASK_DESC}\n\n${summary ? `## Résumé\n${summary}` : ''}\n\nPart of #${ISSUE_ID}`,
      head:  SUB_BRANCH,
      base:  PARENT_BRANCH,
    });

    prNumber = pr?.number ?? null;
    log(`PR #${prNumber} créée : ${SUB_BRANCH} → ${PARENT_BRANCH}`);

    // ── 6. Écrire le résultat ─────────────────────────────────────────────────
    writeResult({
      status:    'done',
      prNumber,
      summary,
      commits:   parseInt(commitCount) || 0,
      iterations,
    });

    log(`✅ Sub-agent terminé — PR #${prNumber}`);

  } catch (err) {
    log(`❌ Erreur sub-agent : ${err.message}`);
    writeResult({ status: 'failed', error: err.message, prNumber: null });
    process.exit(1);
  }
}

main().catch(e => {
  log(`Fatal : ${e.message}`);
  writeResult({ status: 'failed', error: e.message, prNumber: null });
  process.exit(1);
});
