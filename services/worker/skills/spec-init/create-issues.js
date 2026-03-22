#!/usr/bin/env node
/**
 * create-issues.js — Crée les issues Forgejo/GitHub depuis USER_STORIES.md
 * Parse les dépendances "**Dépend de :** US-001, US-002" et les enregistre
 * dans l'orchestrateur via POST /deps pour le DAG.
 *
 * Env requis :
 *   REPO              owner/repo
 *   GIT_PROVIDER_1_URL
 *   GIT_PROVIDER_1_TOKEN (ou FORGEJO_TOKEN)
 *   AGENT_GIT_LOGIN   (défaut: agent)
 *   STORIES_FILE      (défaut: docs/spec/USER_STORIES.md)
 *   ORCHESTRATOR_URL  (défaut: http://localhost:9001)
 */
'use strict';

const fs    = require('fs');
const http  = require('http');
const https = require('https');

const PROVIDER_URL     = process.env.GIT_PROVIDER_1_URL || 'http://host-gateway:3000';
const TOKEN            = process.env.GIT_PROVIDER_1_TOKEN || process.env.FORGEJO_TOKEN || '';
const REPO             = process.env.REPO || '';
const AGENT_LOGIN      = process.env.AGENT_GIT_LOGIN || 'agent';
const STORIES_FILE     = process.env.STORIES_FILE || 'docs/spec/USER_STORIES.md';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:9001';

if (!REPO)  { console.error('REPO non défini'); process.exit(1); }
if (!TOKEN) { console.error('Token git non défini'); process.exit(1); }
if (!fs.existsSync(STORIES_FILE)) {
  console.error(`USER_STORIES.md introuvable : ${STORIES_FILE}`);
  process.exit(1);
}

const content = fs.readFileSync(STORIES_FILE, 'utf8');

// ── Parse USER_STORIES.md ─────────────────────────────────────────────────────
//
// Format attendu :
//   ## US-001 — Titre
//   **Dépend de :** US-003, US-004   ← optionnel
//   ...corps de la story...
//
// L'identifiant US-NNN est utilisé pour le DAG.

const stories = [];
// Découper sur les sections ## US-
const sections = content.split(/(?=^## US-)/m).filter(s => s.trim());

for (const section of sections) {
  const lines      = section.split('\n');
  const headerLine = lines[0].trim();

  // Extraire l'identifiant US-NNN et le titre
  const headerMatch = headerLine.match(/^## (US-(\d+)[^#\n]*)/);
  if (!headerMatch) continue;

  const fullTitle = headerMatch[1].trim();
  const usNum     = headerMatch[2]; // "001"
  const usId      = `US-${usNum}`;  // "US-001"

  // Chercher la ligne **Dépend de :**
  const bodyLines = lines.slice(1);
  const deps      = [];
  const depsLineIdx = bodyLines.findIndex(l =>
    /^\*\*[Dd]épend de\s*:\*\*/.test(l.trim())
  );

  if (depsLineIdx >= 0) {
    const depsMatch = bodyLines[depsLineIdx].match(/\*\*[Dd]épend de\s*:\*\*\s*(.+)/);
    if (depsMatch) {
      // Parser "US-001, US-002" → ['001', '002'] (numéros seulement)
      const rawDeps = depsMatch[1].split(',').map(s => s.trim());
      for (const d of rawDeps) {
        const dm = d.match(/US-(\d+)/);
        if (dm) deps.push(dm[1]); // stocker le numéro sans le "US-"
      }
    }
  }

  const body = bodyLines.join('\n').trim();

  stories.push({ usId, usNum, fullTitle, body, deps });
}

if (!stories.length) {
  console.log('⚠️  Aucune user story trouvée. Format attendu : ## US-001 — Titre');
  process.exit(0);
}

// ── Appels API ────────────────────────────────────────────────────────────────

const [owner, repoName] = REPO.split('/');
const isHttps  = PROVIDER_URL.startsWith('https');
const lib      = isHttps ? https : http;
const baseUrl  = new URL(PROVIDER_URL);

function apiRequest(method, urlStr, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(urlStr);
    const body = payload ? JSON.stringify(payload) : null;
    const opts = {
      method,
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const reqLib = u.protocol === 'https:' ? https : http;
    const req = reqLib.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createIssue(story) {
  const bodyText = story.body +
    (story.deps.length
      ? `\n\n---\n**Dépend de :** ${story.deps.map(n => `#${n}`).join(', ')}`
      : '') +
    '\n\n*Générée automatiquement par `/spec init`*';

  return apiRequest(
    'POST',
    `${PROVIDER_URL}/api/v1/repos/${owner}/${repoName}/issues`,
    { title: story.fullTitle, body: bodyText, assignees: [AGENT_LOGIN] },
    { Authorization: `token ${TOKEN}` }
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n=== /spec init — ${stories.length} user stories sur ${REPO} ===\n`);

  // Première passe : créer toutes les issues et mapper US-NNN → issue number
  const usToIssueNum = {}; // { '001': 3, '002': 4, ... }

  for (const story of stories) {
    try {
      const r = await createIssue(story);
      if (r.data?.number) {
        usToIssueNum[story.usNum] = r.data.number;
        console.log(`✓ #${r.data.number} ${story.fullTitle}` +
          (story.deps.length ? ` [dépend de: ${story.deps.map(n=>`US-${n}`).join(', ')}]` : ''));
      } else {
        console.error(`❌ ${story.fullTitle} : ${JSON.stringify(r.data).slice(0, 100)}`);
      }
      await new Promise(r => setTimeout(r, 600));
    } catch(e) {
      console.error(`❌ ${story.fullTitle} : ${e.message}`);
    }
  }

  // Deuxième passe : enregistrer les dépendances dans l'orchestrateur
  // POST /deps { repo, issueId, deps: [issueNum, ...] }
  const hasDeps = stories.filter(s => s.deps.length > 0);
  if (hasDeps.length > 0) {
    console.log(`\n=== Enregistrement de ${hasDeps.length} dépendances dans l'orchestrateur ===`);
    for (const story of hasDeps) {
      const issueNum = usToIssueNum[story.usNum];
      if (!issueNum) continue;

      // Résoudre les numéros US → numéros d'issues Forgejo
      const depIssueNums = story.deps
        .map(usNum => usToIssueNum[usNum])
        .filter(Boolean);

      if (depIssueNums.length === 0) continue;

      try {
        await apiRequest(
          'POST',
          `${ORCHESTRATOR_URL}/deps`,
          { repo: REPO, issueId: issueNum, deps: depIssueNums.map(String) }
        );
        console.log(`✓ #${issueNum} attend [${depIssueNums.map(n=>`#${n}`).join(', ')}]`);
      } catch(e) {
        console.error(`⚠️ Deps #${issueNum}: ${e.message} (non bloquant)`);
      }
    }
  }

  console.log('\n✅ Terminé.');
  if (Object.keys(usToIssueNum).length > 0) {
    const ready = stories.filter(s => s.deps.length === 0);
    console.log(`   ${ready.length} issue(s) prêtes à démarrer immédiatement.`);
    console.log(`   ${hasDeps.length} issue(s) en attente de dépendances.`);
    console.log('   Le pipeline RBAC démarre automatiquement via webhook Forgejo.');
  }
})();
