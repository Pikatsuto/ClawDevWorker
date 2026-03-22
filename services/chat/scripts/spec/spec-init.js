#!/usr/bin/env node
/**
 * spec-init.js — Orchestrateur /spec init dans le service CHAT
 *
 * Flow complet :
 *   1. Vérifier token user (via user-tokens/<userId>.json)
 *   2. Créer le repo sur le compte du USER (private par défaut)
 *   3. Inviter le compte agent en collaborateur (write)
 *   4. Cloner le repo localement dans /tmp/spec-<repoName>
 *   5. Copier .coderclaw/rules.yaml et .devcontainer/devcontainer.json
 *   6. BMAD génère les artifacts (interactif ou batch)
 *      → _bmad-output/planning-artifacts/USER_STORIES.md
 *   7. Committer tout sur main
 *   8. Parser USER_STORIES.md → issues Forgejo avec dépendances
 *   9. POST /deps sur l'orchestrateur → DAG
 *  10. Les webhooks déclenchent le pipeline RBAC
 *
 * Usage CLI (appelé par le skill) :
 *   node spec-init.js --name <nom> [--brief <brief.md>] [--public]
 *
 * Env :
 *   USER_ID                   identifiant du user
 *   GIT_PROVIDER_1_URL        URL Forgejo
 *   AGENT_GIT_LOGIN           login du compte agent (défaut: agent)
 *   ORCHESTRATOR_URL          http://openclaw-agent:9001
 *   PROJECT_DATA_DIR          /projects
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http  = require('http');
const https = require('https');
const { execSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const USER_ID          = process.env.USER_ID          || 'default';
const PROVIDER_URL     = process.env.GIT_PROVIDER_1_URL || 'http://host-gateway:3000';
const AGENT_LOGIN      = process.env.AGENT_GIT_LOGIN  || 'agent';
const AGENT_TOKEN      = process.env.GIT_PROVIDER_1_TOKEN || process.env.FORGEJO_TOKEN || '';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://openclaw-agent:9001';
const PROJECT_DATA_DIR = process.env.PROJECT_DATA_DIR || '/projects';

const TOKEN_DIR  = path.join(process.env.HOME, '.openclaw', 'user-tokens');
const TOKEN_FILE = path.join(TOKEN_DIR, `${USER_ID}.json`);

// Templates embarqués dans l'image
const RULES_TEMPLATE   = '/opt/devcontainer/defaults/coderclaw-rules.yaml';
const DC_TEMPLATE      = '/opt/devcontainer/defaults/devcontainer.json';
const BMAD_OUTPUT_DIR  = process.env.BMAD_OUTPUT_DIR || '/tmp/bmad-output';

function log(msg) { console.log(`[spec-init] ${msg}`); }
function fail(msg) { console.error(`[spec-init] ❌ ${msg}`); process.exit(1); }

// ── Helpers HTTP ──────────────────────────────────────────────────────────────
function apiCall(method, urlStr, payload, token) {
  return new Promise((resolve, reject) => {
    const u    = new URL(urlStr);
    const body = payload ? JSON.stringify(payload) : null;
    const lib  = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `token ${token}`,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const req = lib.request(opts, res => {
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

// ── 1. Charger le token user ──────────────────────────────────────────────────
function loadUserToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    fail('Token git non configuré.\nUtilise /token set <token> pour enregistrer ton token Forgejo/GitHub.');
  }
  const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const token  = tokens.forgejo || tokens.github;
  if (!token) {
    fail('Aucun token git trouvé.\nUtilise /token set forgejo <token> ou /token set github <token>.');
  }
  return token;
}

// ── 2. Créer le repo sur le compte du USER ────────────────────────────────────
async function createRepo(userToken, name, description, isPrivate) {
  log(`Création du repo "${name}" sur ton compte...`);
  const r = await apiCall('POST', `${PROVIDER_URL}/api/v1/user/repos`, {
    name, description, private: isPrivate, auto_init: true,
    default_branch: 'main',
  }, userToken);

  if (r.status === 201) {
    log(`✓ Repo créé : ${r.data.full_name}`);
    return r.data;
  }
  if (r.status === 409) {
    log(`⚠ Repo déjà existant — utilisation du repo existant`);
    // Récupérer le repo existant
    const existing = await apiCall('GET', `${PROVIDER_URL}/api/v1/repos/${r.data.message?.match(/\w+\/\w+/)?.[0] || name}`,
      null, userToken);
    return existing.data;
  }
  fail(`Erreur création repo (${r.status}) : ${JSON.stringify(r.data).slice(0, 200)}`);
}

// ── 3. Récupérer le login user depuis le token ────────────────────────────────
async function getUserLogin(userToken) {
  const r = await apiCall('GET', `${PROVIDER_URL}/api/v1/user`, null, userToken);
  if (r.status === 200) return r.data.login;
  fail(`Token invalide (${r.status})`);
}

// ── 4. Inviter le compte agent en collaborateur ───────────────────────────────
async function inviteAgent(userToken, owner, repoName) {
  log(`Invitation de @${AGENT_LOGIN} comme collaborateur...`);
  const r = await apiCall(
    'PUT',
    `${PROVIDER_URL}/api/v1/repos/${owner}/${repoName}/collaborators/${AGENT_LOGIN}`,
    { permission: 'write' },
    userToken
  );
  if (r.status === 204 || r.status === 200) {
    log(`✓ @${AGENT_LOGIN} invité en collaborateur (write)`);
  } else {
    log(`⚠ Invitation échouée (${r.status}) — tu devras ajouter @${AGENT_LOGIN} manuellement`);
  }
}

// ── 5. Configurer le webhook Forgejo → orchestrateur ─────────────────────────
async function setupWebhook(userToken, owner, repoName) {
  log(`Configuration du webhook...`);
  // L'URL du webhook est l'URL interne de l'agent (accessible depuis le réseau Docker)
  // En production, utiliser l'URL publique de l'agent si disponible
  const webhookUrl = `http://openclaw-agent:9000/webhook`;
  const r = await apiCall(
    'POST',
    `${PROVIDER_URL}/api/v1/repos/${owner}/${repoName}/hooks`,
    {
      type: 'gitea',
      config: {
        url:          webhookUrl,
        content_type: 'json',
        secret:       process.env.GIT_PROVIDER_1_WEBHOOK_SECRET || '',
      },
      events:       ['issues', 'issue_comment', 'pull_request'],
      branch_filter: '*',
      active:       true,
    },
    userToken
  );
  if (r.status === 201) {
    log(`✓ Webhook configuré → ${webhookUrl}`);
  } else {
    log(`⚠ Webhook échoué (${r.status}) — configure-le manuellement dans Forgejo`);
  }
}

// ── 6. Initialiser le repo avec les fichiers de base ─────────────────────────
function initRepo(userToken, owner, repoName) {
  log(`Clone du repo...`);
  const cloneDir = `/tmp/spec-${repoName}-${Date.now()}`;
  const cloneUrl = `${PROVIDER_URL.replace('://', `://agent:${AGENT_TOKEN}@`)}/${owner}/${repoName}.git`;

  execSync(`git clone ${cloneUrl} ${cloneDir}`, { stdio: 'pipe' });
  execSync(`git -C ${cloneDir} config user.email "agent@clawdevworker.local"`);
  execSync(`git -C ${cloneDir} config user.name "CoderClaw Agent"`);

  // Créer la structure de base
  fs.mkdirSync(`${cloneDir}/.coderclaw`, { recursive: true });
  fs.mkdirSync(`${cloneDir}/.devcontainer`, { recursive: true });
  fs.mkdirSync(`${cloneDir}/docs/spec`, { recursive: true });

  // Copier les templates
  if (fs.existsSync(RULES_TEMPLATE)) {
    fs.copyFileSync(RULES_TEMPLATE, `${cloneDir}/.coderclaw/rules.yaml`);
  } else {
    fs.writeFileSync(`${cloneDir}/.coderclaw/rules.yaml`,
      `pipeline:\n  gates: [architect, fullstack, security, qa, doc]\n  max_retries: 3\n  retry_upgrade: true\n`);
  }

  if (fs.existsSync(DC_TEMPLATE)) {
    fs.copyFileSync(DC_TEMPLATE, `${cloneDir}/.devcontainer/devcontainer.json`);
  }

  return cloneDir;
}

// ── 7. Copier les artifacts BMAD dans le repo ─────────────────────────────────
function copyBmadArtifacts(cloneDir) {
  const srcDir = `${BMAD_OUTPUT_DIR}/planning-artifacts`;
  if (!fs.existsSync(srcDir)) {
    fail(`Artifacts BMAD introuvables dans ${srcDir}.\nLance /bmad full d'abord.`);
  }
  for (const file of ['product-brief.md', 'PRD.md', 'ARCHITECTURE.md', 'USER_STORIES.md']) {
    const src = path.join(srcDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, `${cloneDir}/docs/spec/${file}`);
      log(`✓ ${file} copié`);
    } else {
      log(`⚠ ${file} absent — ignoré`);
    }
  }
}

// ── 8. Commit et push ─────────────────────────────────────────────────────────
function commitAndPush(cloneDir, repoName) {
  log(`Commit et push de la spec...`);
  execSync(`git -C ${cloneDir} add -A`);
  execSync(`git -C ${cloneDir} commit -m "chore: initialize project spec via BMAD"`);
  execSync(`git -C ${cloneDir} push origin main`);
  log(`✓ Spec committée sur main`);
}

// ── 9. Créer les issues avec DAG ──────────────────────────────────────────────
async function createIssuesFromStories(userToken, owner, repoName) {
  const storiesFile = `${BMAD_OUTPUT_DIR}/planning-artifacts/USER_STORIES.md`;
  if (!fs.existsSync(storiesFile)) {
    log(`⚠ USER_STORIES.md absent — issues non créées`);
    return;
  }

  const content  = fs.readFileSync(storiesFile, 'utf8');
  const stories  = [];
  const sections = content.split(/(?=^## US-)/m).filter(s => /^## US-\d+/.test(s.trim()));

  for (const section of sections) {
    const lines      = section.split('\n');
    const headerLine = lines[0].trim();
    const hm = headerLine.match(/^## (US-(\d+)[^\n]*)/);
    if (!hm) continue;

    const fullTitle = hm[1].trim();
    const usNum     = hm[2];
    const bodyLines = lines.slice(1);

    // Parser les dépendances "**Dépend de :** US-001, US-002"
    const deps = [];
    for (const line of bodyLines) {
      const dm = line.match(/\*\*[Dd]épend de\s*:\*\*\s*(.+)/);
      if (dm) {
        dm[1].split(',').forEach(d => {
          const nm = d.trim().match(/US-(\d+)/);
          if (nm) deps.push(nm[1]);
        });
      }
    }

    stories.push({ usNum, fullTitle, body: bodyLines.join('\n').trim(), deps });
  }

  if (!stories.length) {
    log(`⚠ Aucune story parsée depuis USER_STORIES.md`);
    return;
  }

  log(`\nCréation de ${stories.length} issues sur ${owner}/${repoName}...`);
  const usToIssue = {}; // usNum → issue number

  for (const story of stories) {
    const bodyText = story.body +
      (story.deps.length ? `\n\n---\n**Dépend de :** ${story.deps.map(n => `#${n}`).join(', ')}` : '') +
      `\n\n*Générée par \`/spec init\`*`;

    const r = await apiCall(
      'POST',
      `${PROVIDER_URL}/api/v1/repos/${owner}/${repoName}/issues`,
      { title: story.fullTitle, body: bodyText, assignees: [AGENT_LOGIN] },
      userToken
    );

    if (r.data?.number) {
      usToIssue[story.usNum] = r.data.number;
      log(`  ✓ #${r.data.number} ${story.fullTitle}` +
        (story.deps.length ? ` [dépend de: ${story.deps.map(n => `US-${n}`).join(', ')}]` : ''));
    } else {
      log(`  ❌ ${story.fullTitle} : ${JSON.stringify(r.data).slice(0, 100)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Enregistrer le DAG dans l'orchestrateur
  const hasDeps = stories.filter(s => s.deps.length > 0);
  if (hasDeps.length > 0) {
    log(`\nEnregistrement de ${hasDeps.length} dépendances...`);
    for (const story of hasDeps) {
      const issueNum = usToIssue[story.usNum];
      if (!issueNum) continue;
      const depNums = story.deps.map(usNum => usToIssue[usNum]).filter(Boolean);
      if (!depNums.length) continue;

      await new Promise((resolve, reject) => {
        const u = new URL(`${ORCHESTRATOR_URL}/deps`);
        const body = JSON.stringify({ repo: `${owner}/${repoName}`, issueId: issueNum, deps: depNums.map(String) });
        const req = http.request({
          method: 'POST', hostname: u.hostname, port: u.port || 9001, path: '/deps',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', e => { log(`⚠ DAG #${issueNum}: ${e.message}`); resolve(); });
        req.write(body); req.end();
      });
      log(`  ✓ #${issueNum} attend [${depNums.map(n => `#${n}`).join(', ')}]`);
    }
  }

  return { stories: stories.length, issues: Object.keys(usToIssue).length };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args  = process.argv.slice(2);
  const name  = args[args.indexOf('--name') + 1];
  const brief = args.includes('--brief') ? args[args.indexOf('--brief') + 1] : null;
  const isPublic = args.includes('--public');

  if (!name) fail('Usage : node spec-init.js --name <nom> [--brief <brief.md>] [--public]');

  log(`\n=== /spec init "${name}" ===\n`);

  // 1. Token user
  const userToken = loadUserToken();
  const userLogin = await getUserLogin(userToken);
  log(`✓ Connecté en tant que @${userLogin}`);

  // 2. Créer le repo
  const repo = await createRepo(userToken, name,
    `Projet initialisé via clawdevworker`, !isPublic);
  const owner = repo.owner?.login || userLogin;

  // 3. Inviter l'agent
  await inviteAgent(userToken, owner, name);

  // 4. Configurer le webhook
  await setupWebhook(userToken, owner, name);

  // 5. Si mode batch, lancer BMAD headless
  if (brief) {
    log(`\nMode batch — brief : ${brief}`);
    if (!fs.existsSync(brief)) fail(`Brief introuvable : ${brief}`);
    // En mode batch, le BMAD tourne headless via le skill
    // Le brief est copié dans le dossier BMAD output pour que l'agent le lise
    fs.mkdirSync(`${BMAD_OUTPUT_DIR}/planning-artifacts`, { recursive: true });
    fs.copyFileSync(brief, `${BMAD_OUTPUT_DIR}/planning-artifacts/product-brief.md`);
    log(`Brief copié — l'agent BMAD va générer la spec de façon autonome`);
    log(`Lance /bmad prd puis /bmad arch puis /bmad stories, ou /bmad full pour tout en une fois`);
  } else {
    log(`\nMode interactif — Lance /bmad full pour démarrer la spec`);
    log(`Une fois la spec complète, lance /spec push ${owner}/${name} pour créer les issues`);
  }

  // Sauvegarder le contexte pour /spec push
  const ctxFile = path.join(process.env.HOME, '.openclaw', 'spec-context.json');
  fs.writeFileSync(ctxFile, JSON.stringify({
    owner, repoName: name, userToken: '***', fullName: `${owner}/${name}`,
    createdAt: new Date().toISOString(),
  }, null, 2));

  log(`\nContexte sauvegardé. Repo : https://${new URL(PROVIDER_URL).hostname}/${owner}/${name}`);
}

// ── Mode "push" — appelé après BMAD ──────────────────────────────────────────
async function push(ownerRepo) {
  const [owner, repoName] = ownerRepo.split('/');
  if (!owner || !repoName) fail('Format attendu : owner/repo');

  const userToken = loadUserToken();
  const cloneDir  = initRepo(userToken, owner, repoName);
  copyBmadArtifacts(cloneDir);
  commitAndPush(cloneDir, repoName);

  const result = await createIssuesFromStories(userToken, owner, repoName);

  log(`\n✅ /spec init terminé !`);
  log(`  Repo       : ${PROVIDER_URL}/${owner}/${repoName}`);
  log(`  Issues     : ${result?.issues || 0} créées`);
  log(`  Pipeline   : démarrage automatique via webhook`);
}

// CLI dispatch
const cmd = process.argv[2];
if (cmd === 'push') {
  push(process.argv[3]).catch(e => fail(e.message));
} else {
  main().catch(e => fail(e.message));
}
