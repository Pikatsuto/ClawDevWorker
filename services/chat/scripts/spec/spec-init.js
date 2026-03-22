#!/usr/bin/env node
/**
 * spec-init.js — /spec init orchestrator in the CHAT service
 *
 * Full flow:
 *   1. Verify user token (via user-tokens/<userId>.json)
 *   2. Create the repo on the USER's account (private by default)
 *   3. Invite the agent account as a collaborator (write)
 *   4. Clone the repo locally into /tmp/spec-<repoName>
 *   5. Copy .coderclaw/rules.yaml and .devcontainer/devcontainer.json
 *   6. BMAD generates artifacts (interactive or batch)
 *      → _bmad-output/planning-artifacts/USER_STORIES.md
 *   7. Commit everything to main
 *   8. Parse USER_STORIES.md → Forgejo issues with dependencies
 *   9. POST /deps to the orchestrator → DAG
 *  10. Webhooks trigger the RBAC pipeline
 *
 * CLI usage (called by the skill):
 *   node spec-init.js --name <name> [--brief <brief.md>] [--public]
 *
 * Env:
 *   USER_ID                   user identifier
 *   GIT_PROVIDER_1_URL        Forgejo URL
 *   AGENT_GIT_LOGIN           agent account login (default: agent)
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

// Templates bundled in the image
const RULES_TEMPLATE   = '/opt/devcontainer/defaults/coderclaw-rules.yaml';
const DC_TEMPLATE      = '/opt/devcontainer/defaults/devcontainer.json';
const BMAD_OUTPUT_DIR  = process.env.BMAD_OUTPUT_DIR || '/tmp/bmad-output';

function log(msg) { console.log(`[spec-init] ${msg}`); }
function fail(msg) { console.error(`[spec-init] ❌ ${msg}`); process.exit(1); }

// ── HTTP Helpers ─────────────────────────────────────────────────────────────
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

// ── 1. Load user token ───────────────────────────────────────────────────────
function loadUserToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    fail('Git token not configured.\nUse /token set <token> to register your Forgejo/GitHub token.');
  }
  const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const token  = tokens.forgejo || tokens.github;
  if (!token) {
    fail('No git token found.\nUse /token set forgejo <token> or /token set github <token>.');
  }
  return token;
}

// ── 2. Create the repo on the USER's account ─────────────────────────────────
async function createRepo(userToken, name, description, isPrivate) {
  log(`Creating repo "${name}" on your account...`);
  const r = await apiCall('POST', `${PROVIDER_URL}/api/v1/user/repos`, {
    name, description, private: isPrivate, auto_init: true,
    default_branch: 'main',
  }, userToken);

  if (r.status === 201) {
    log(`✓ Repo created: ${r.data.full_name}`);
    return r.data;
  }
  if (r.status === 409) {
    log(`⚠ Repo already exists — using existing repo`);
    // Retrieve the existing repo
    const existing = await apiCall('GET', `${PROVIDER_URL}/api/v1/repos/${r.data.message?.match(/\w+\/\w+/)?.[0] || name}`,
      null, userToken);
    return existing.data;
  }
  fail(`Repo creation error (${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`);
}

// ── 3. Retrieve user login from token ────────────────────────────────────────
async function getUserLogin(userToken) {
  const r = await apiCall('GET', `${PROVIDER_URL}/api/v1/user`, null, userToken);
  if (r.status === 200) return r.data.login;
  fail(`Invalid token (${r.status})`);
}

// ── 4. Invite the agent account as collaborator ──────────────────────────────
async function inviteAgent(userToken, owner, repoName) {
  log(`Inviting @${AGENT_LOGIN} as collaborator...`);
  const r = await apiCall(
    'PUT',
    `${PROVIDER_URL}/api/v1/repos/${owner}/${repoName}/collaborators/${AGENT_LOGIN}`,
    { permission: 'write' },
    userToken
  );
  if (r.status === 204 || r.status === 200) {
    log(`✓ @${AGENT_LOGIN} invited as collaborator (write)`);
  } else {
    log(`⚠ Invitation failed (${r.status}) — you will need to add @${AGENT_LOGIN} manually`);
  }
}

// ── 5. Configure the Forgejo webhook → orchestrator ─────────────────────────
async function setupWebhook(userToken, owner, repoName) {
  log(`Configuring webhook...`);
  // The webhook URL is the agent's internal URL (accessible from the Docker network)
  // In production, use the agent's public URL if available
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
    log(`✓ Webhook configured → ${webhookUrl}`);
  } else {
    log(`⚠ Webhook failed (${r.status}) — configure it manually in Forgejo`);
  }
}

// ── 6. Initialize the repo with base files ───────────────────────────────────
function initRepo(userToken, owner, repoName) {
  log(`Cloning repo...`);
  const cloneDir = `/tmp/spec-${repoName}-${Date.now()}`;
  const cloneUrl = `${PROVIDER_URL.replace('://', `://agent:${AGENT_TOKEN}@`)}/${owner}/${repoName}.git`;

  execSync(`git clone ${cloneUrl} ${cloneDir}`, { stdio: 'pipe' });
  execSync(`git -C ${cloneDir} config user.email "agent@clawdevworker.local"`);
  execSync(`git -C ${cloneDir} config user.name "CoderClaw Agent"`);

  // Create the base structure
  fs.mkdirSync(`${cloneDir}/.coderclaw`, { recursive: true });
  fs.mkdirSync(`${cloneDir}/.devcontainer`, { recursive: true });
  fs.mkdirSync(`${cloneDir}/docs/spec`, { recursive: true });

  // Copy the templates
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

// ── 7. Copy BMAD artifacts into the repo ──────────────────────────────────────
function copyBmadArtifacts(cloneDir) {
  const srcDir = `${BMAD_OUTPUT_DIR}/planning-artifacts`;
  if (!fs.existsSync(srcDir)) {
    fail(`BMAD artifacts not found in ${srcDir}.\nRun /bmad full first.`);
  }
  for (const file of ['product-brief.md', 'PRD.md', 'ARCHITECTURE.md', 'USER_STORIES.md']) {
    const src = path.join(srcDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, `${cloneDir}/docs/spec/${file}`);
      log(`✓ ${file} copied`);
    } else {
      log(`⚠ ${file} missing — skipped`);
    }
  }
}

// ── 8. Commit and push ────────────────────────────────────────────────────────
function commitAndPush(cloneDir, repoName) {
  log(`Committing and pushing spec...`);
  execSync(`git -C ${cloneDir} add -A`);
  execSync(`git -C ${cloneDir} commit -m "chore: initialize project spec via BMAD"`);
  execSync(`git -C ${cloneDir} push origin main`);
  log(`✓ Spec committed to main`);
}

// ── 9. Create issues with DAG ─────────────────────────────────────────────────
async function createIssuesFromStories(userToken, owner, repoName) {
  const storiesFile = `${BMAD_OUTPUT_DIR}/planning-artifacts/USER_STORIES.md`;
  if (!fs.existsSync(storiesFile)) {
    log(`⚠ USER_STORIES.md missing — issues not created`);
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

    // Parse dependencies "**Dépend de :** US-001, US-002"
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
    log(`⚠ No stories parsed from USER_STORIES.md`);
    return;
  }

  log(`\nCreating ${stories.length} issues on ${owner}/${repoName}...`);
  const usToIssue = {}; // usNum → issue number

  for (const story of stories) {
    const bodyText = story.body +
      (story.deps.length ? `\n\n---\n**Depends on:** ${story.deps.map(n => `#${n}`).join(', ')}` : '') +
      `\n\n*Generated by \`/spec init\`*`;

    const r = await apiCall(
      'POST',
      `${PROVIDER_URL}/api/v1/repos/${owner}/${repoName}/issues`,
      { title: story.fullTitle, body: bodyText, assignees: [AGENT_LOGIN] },
      userToken
    );

    if (r.data?.number) {
      usToIssue[story.usNum] = r.data.number;
      log(`  ✓ #${r.data.number} ${story.fullTitle}` +
        (story.deps.length ? ` [depends on: ${story.deps.map(n => `US-${n}`).join(', ')}]` : ''));
    } else {
      log(`  ❌ ${story.fullTitle} : ${JSON.stringify(r.data).slice(0, 100)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Register the DAG in the orchestrator
  const hasDeps = stories.filter(s => s.deps.length > 0);
  if (hasDeps.length > 0) {
    log(`\nRegistering ${hasDeps.length} dependencies...`);
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

  if (!name) fail('Usage: node spec-init.js --name <name> [--brief <brief.md>] [--public]');

  log(`\n=== /spec init "${name}" ===\n`);

  // 1. Token user
  const userToken = loadUserToken();
  const userLogin = await getUserLogin(userToken);
  log(`✓ Logged in as @${userLogin}`);

  // 2. Create the repo
  const repo = await createRepo(userToken, name,
    `Project initialized via clawdevworker`, !isPublic);
  const owner = repo.owner?.login || userLogin;

  // 3. Invite the agent
  await inviteAgent(userToken, owner, name);

  // 4. Configure the webhook
  await setupWebhook(userToken, owner, name);

  // 5. If batch mode, launch BMAD headless
  if (brief) {
    log(`\nBatch mode — brief: ${brief}`);
    if (!fs.existsSync(brief)) fail(`Brief not found: ${brief}`);
    // In batch mode, BMAD runs headless via the skill
    // The brief is copied to the BMAD output folder for the agent to read
    fs.mkdirSync(`${BMAD_OUTPUT_DIR}/planning-artifacts`, { recursive: true });
    fs.copyFileSync(brief, `${BMAD_OUTPUT_DIR}/planning-artifacts/product-brief.md`);
    log(`Brief copied — the BMAD agent will generate the spec autonomously`);
    log(`Run /bmad prd then /bmad arch then /bmad stories, or /bmad full for everything at once`);
  } else {
    log(`\nInteractive mode — Run /bmad full to start the spec`);
    log(`Once the spec is complete, run /spec push ${owner}/${name} to create the issues`);
  }

  // Save context for /spec push
  const ctxFile = path.join(process.env.HOME, '.openclaw', 'spec-context.json');
  fs.writeFileSync(ctxFile, JSON.stringify({
    owner, repoName: name, userToken: '***', fullName: `${owner}/${name}`,
    createdAt: new Date().toISOString(),
  }, null, 2));

  log(`\nContext saved. Repo: https://${new URL(PROVIDER_URL).hostname}/${owner}/${name}`);
}

// ── "push" mode — called after BMAD ──────────────────────────────────────────
async function push(ownerRepo) {
  const [owner, repoName] = ownerRepo.split('/');
  if (!owner || !repoName) fail('Expected format: owner/repo');

  const userToken = loadUserToken();
  const cloneDir  = initRepo(userToken, owner, repoName);
  copyBmadArtifacts(cloneDir);
  commitAndPush(cloneDir, repoName);

  const result = await createIssuesFromStories(userToken, owner, repoName);

  log(`\n✅ /spec init completed!`);
  log(`  Repo       : ${PROVIDER_URL}/${owner}/${repoName}`);
  log(`  Issues     : ${result?.issues || 0} created`);
  log(`  Pipeline   : automatic start via webhook`);
}

// CLI dispatch
const cmd = process.argv[2];
if (cmd === 'push') {
  push(process.argv[3]).catch(e => fail(e.message));
} else {
  main().catch(e => fail(e.message));
}
