#!/usr/bin/env node
/**
 * spec-init.js — /spec init orchestrator in the CHAT service
 *
 * Full flow:
 *   1. Verify user token (via user-tokens/<userId>.json)
 *   2. Detect provider (forgejo or github) from the token
 *   3. Create the repo on the USER's account (private by default)
 *   4. Invite the agent account as a collaborator (write)
 *   5. Configure webhook → orchestrator
 *   6. Protect the main branch (1 required approval)
 *   7. Clone the repo locally into /tmp/spec-<repoName>
 *   8. Copy .coderclaw/rules.yaml and .devcontainer/devcontainer.json
 *   9. BMAD generates artifacts (interactive or batch)
 *  10. Commit everything to main
 *  11. Parse USER_STORIES.md → issues with dependencies
 *  12. POST /deps to the orchestrator → DAG
 *  13. Webhooks trigger the RBAC pipeline
 *
 * CLI usage (called by the skill):
 *   node spec-init.js --name <name> [--provider forgejo|github] [--brief <brief.md>] [--public]
 *   node spec-init.js push <owner/repo>
 *
 * Env:
 *   USER_ID                   user identifier
 *   GIT_PROVIDER_1, GIT_PROVIDER_1_URL, GIT_PROVIDER_1_TOKEN
 *   GIT_PROVIDER_2, GIT_PROVIDER_2_APP_ID, GIT_PROVIDER_2_PRIVATE_KEY_B64
 *   AGENT_GIT_LOGIN           agent account login (default: agent)
 *   ORCHESTRATOR_URL          http://openclaw-agent:9001
 *   PROJECT_DATA_DIR          /projects
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const { loadProviders, getProviderForRepo } = require('/opt/git-provider/index.js');

// ── Config ────────────────────────────────────────────────────────────────────
const USER_ID          = process.env.USER_ID          || 'default';
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

// ── Load git providers ──────────────────────────────────────────────────────
let gitProviders;
try { gitProviders = loadProviders(); }
catch (e) { fail(`Failed to load git providers: ${e.message}`); }

function getProvider(providerHint) {
  if (providerHint) {
    const found = [...gitProviders.values()].find(p => p.type === providerHint);
    if (!found) fail(`Provider "${providerHint}" not configured. Available: ${[...gitProviders.values()].map(p => p.type).join(', ')}`);
    return found;
  }
  // Default: first available provider
  const first = [...gitProviders.values()][0];
  if (!first) fail('No git provider configured.');
  return first;
}

// ── 1. Load user token ───────────────────────────────────────────────────────
function loadUserToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    fail('Git token not configured.\nUse /token set <token> to register your Forgejo/GitHub token.');
  }
  const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  return tokens;
}

function detectProviderFromToken(tokens, providerHint) {
  if (providerHint) return providerHint;
  if (tokens.github && [...gitProviders.values()].some(p => p.type === 'github')) return 'github';
  if (tokens.forgejo) return 'forgejo';
  return [...gitProviders.values()][0]?.type || 'forgejo';
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args  = process.argv.slice(2);
  const name  = args[args.indexOf('--name') + 1];
  const brief = args.includes('--brief') ? args[args.indexOf('--brief') + 1] : null;
  const isPublic = args.includes('--public');
  const providerHint = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : null;

  if (!name) fail('Usage: node spec-init.js --name <name> [--provider forgejo|github] [--brief <brief.md>] [--public]');

  log(`\n=== /spec init "${name}" ===\n`);

  // 1. Token user + provider detection
  const tokens       = loadUserToken();
  const providerType = detectProviderFromToken(tokens, providerHint);
  const provider     = getProvider(providerType);
  const userToken    = tokens[providerType] || tokens.forgejo || tokens.github;

  if (!userToken) fail(`No token found for provider "${providerType}".`);
  log(`Provider: ${providerType}`);

  // 2. Get user login (use the agent provider since user token may differ)
  // For Forgejo, we can validate via the API; for GitHub, the token is a PAT
  let userLogin;
  try {
    // Both Forgejo and GitHub support GET /user with a token
    const tmpProvider = providerType === 'github'
      ? new (require('/opt/git-provider/github.js'))({ appId: '', privateKeyB64: '' })
      : provider;
    // Simple HTTP call to get user login
    const http_ = require(provider.baseUrl?.startsWith('https') ? 'https' : 'http');
    const baseUrl = providerType === 'github' ? 'https://api.github.com' : provider.baseUrl;
    const authHeader = providerType === 'github' ? `Bearer ${userToken}` : `token ${userToken}`;
    const userData = await new Promise((resolve, reject) => {
      const u = new URL(`${baseUrl}${providerType === 'github' ? '' : '/api/v1'}/user`);
      const opts = {
        method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        headers: { Authorization: authHeader, Accept: 'application/json', 'User-Agent': 'clawdevworker/1.0' },
      };
      const req = (u.protocol === 'https:' ? require('https') : require('http')).request(opts, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
      });
      req.on('error', reject); req.end();
    });
    userLogin = userData.login;
    if (!userLogin) fail('Failed to authenticate — check your token.');
  } catch (e) {
    fail(`Authentication error: ${e.message}`);
  }
  log(`✓ Logged in as @${userLogin}`);

  // 3. Create the repo (using the provider abstraction)
  log(`Creating repo "${name}" on your account...`);
  try {
    const repo = await provider.createRepo(name, { private: !isPublic, description: 'Project initialized via clawdevworker' });
    log(`✓ Repo created: ${repo.full_name || `${userLogin}/${name}`}`);
  } catch (e) {
    if (e.message?.includes('409') || e.message?.includes('already')) {
      log(`⚠ Repo already exists — using existing repo`);
    } else {
      log(`⚠ Repo creation: ${e.message} — may already exist, continuing...`);
    }
  }
  const owner = userLogin;

  // 4. Invite the agent
  log(`Inviting @${AGENT_LOGIN} as collaborator...`);
  try {
    await provider.addCollaborator(`${owner}/${name}`, AGENT_LOGIN, providerType === 'github' ? 'push' : 'write');
    log(`✓ @${AGENT_LOGIN} invited as collaborator`);
  } catch (e) {
    log(`⚠ Invitation failed: ${e.message} — add @${AGENT_LOGIN} manually`);
  }

  // 5. Configure the webhook
  log(`Configuring webhook...`);
  const webhookUrl = 'http://openclaw-agent:9000/webhook';
  try {
    await provider.createWebhook(`${owner}/${name}`, {
      url: webhookUrl,
      secret: process.env.GIT_PROVIDER_1_WEBHOOK_SECRET || '',
      events: ['issues', 'issue_comment', 'pull_request'],
    });
    log(`✓ Webhook configured → ${webhookUrl}`);
  } catch (e) {
    log(`⚠ Webhook failed: ${e.message} — configure it manually`);
  }

  // 6. Protect the main branch
  log(`Setting up branch protection on main...`);
  try {
    await provider.protectBranch(`${owner}/${name}`, 'main', { requiredApprovals: 1 });
    log(`✓ Branch protection enabled (1 required approval)`);
  } catch (e) {
    log(`⚠ Branch protection failed: ${e.message} — configure it manually`);
  }

  // 7. If batch mode, launch BMAD headless
  if (brief) {
    log(`\nBatch mode — brief: ${brief}`);
    if (!fs.existsSync(brief)) fail(`Brief not found: ${brief}`);
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
    owner, repoName: name, providerType, fullName: `${owner}/${name}`,
    createdAt: new Date().toISOString(),
  }, null, 2));

  const repoUrl = providerType === 'github'
    ? `https://github.com/${owner}/${name}`
    : `${provider.baseUrl}/${owner}/${name}`;
  log(`\nContext saved. Repo: ${repoUrl}`);
}

// ── "push" mode — called after BMAD ──────────────────────────────────────────
async function push(ownerRepo) {
  const [owner, repoName] = ownerRepo.split('/');
  if (!owner || !repoName) fail('Expected format: owner/repo');

  const tokens    = loadUserToken();
  const userToken = tokens.forgejo || tokens.github;

  // Load context to determine provider
  const ctxFile = path.join(process.env.HOME, '.openclaw', 'spec-context.json');
  let providerType = 'forgejo';
  if (fs.existsSync(ctxFile)) {
    const ctx = JSON.parse(fs.readFileSync(ctxFile, 'utf8'));
    providerType = ctx.providerType || 'forgejo';
  }
  const provider = getProvider(providerType);

  // Clone
  log(`Cloning repo...`);
  const cloneDir = `/tmp/spec-${repoName}-${Date.now()}`;
  const cloneUrl = provider.cloneUrl(`${owner}/${repoName}`);
  execSync(`git clone ${cloneUrl} ${cloneDir}`, { stdio: 'pipe' });
  execSync(`git -C ${cloneDir} config user.email "agent@clawdevworker.local"`);
  execSync(`git -C ${cloneDir} config user.name "CoderClaw Agent"`);

  // Create base structure
  fs.mkdirSync(`${cloneDir}/.coderclaw`, { recursive: true });
  fs.mkdirSync(`${cloneDir}/.devcontainer`, { recursive: true });
  fs.mkdirSync(`${cloneDir}/docs/spec`, { recursive: true });

  if (fs.existsSync(RULES_TEMPLATE)) {
    fs.copyFileSync(RULES_TEMPLATE, `${cloneDir}/.coderclaw/rules.yaml`);
  } else {
    fs.writeFileSync(`${cloneDir}/.coderclaw/rules.yaml`,
      `pipeline:\n  gates: [architect, fullstack, security, qa, doc]\n  max_retries: 3\n  retry_upgrade: true\n`);
  }
  if (fs.existsSync(DC_TEMPLATE)) {
    fs.copyFileSync(DC_TEMPLATE, `${cloneDir}/.devcontainer/devcontainer.json`);
  }

  // Copy auto-promote workflow
  const WORKFLOW_TEMPLATE = '/opt/devcontainer/defaults/workflows/auto-promote.yml';
  if (fs.existsSync(WORKFLOW_TEMPLATE)) {
    fs.mkdirSync(`${cloneDir}/.github/workflows`, { recursive: true });
    fs.copyFileSync(WORKFLOW_TEMPLATE, `${cloneDir}/.github/workflows/auto-promote.yml`);
    log(`✓ auto-promote workflow copied`);
  }

  // Copy BMAD artifacts
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

  // Commit and push
  log(`Committing and pushing spec...`);
  execSync(`git -C ${cloneDir} add -A`);
  execSync(`git -C ${cloneDir} commit -m "chore: initialize project spec via BMAD"`);
  execSync(`git -C ${cloneDir} push origin main`);
  log(`✓ Spec committed to main`);

  // Create issues
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
    const deps = [];
    for (const line of bodyLines) {
      const dm = line.match(/\*\*[Dd](?:épend de|epends on)\s*:\*\*\s*(.+)/);
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
  const usToIssue = {};
  const repo = `${owner}/${repoName}`;

  for (const story of stories) {
    const bodyText = story.body +
      (story.deps.length ? `\n\n---\n**Depends on:** ${story.deps.map(n => `#${n}`).join(', ')}` : '') +
      `\n\n*Generated by \`/spec init\`*`;

    try {
      // Use the provider abstraction — both Forgejo and GitHub share the same issue creation endpoint pattern
      const r = await provider._req('POST', `/repos/${owner}/${repoName}/issues`,
        { title: story.fullTitle, body: bodyText, assignees: [AGENT_LOGIN] });

      if (r.data?.number) {
        usToIssue[story.usNum] = r.data.number;
        log(`  ✓ #${r.data.number} ${story.fullTitle}` +
          (story.deps.length ? ` [depends on: ${story.deps.map(n => `US-${n}`).join(', ')}]` : ''));
      } else {
        log(`  ❌ ${story.fullTitle}: ${JSON.stringify(r.data).slice(0, 100)}`);
      }
    } catch (e) {
      log(`  ❌ ${story.fullTitle}: ${e.message}`);
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

      await new Promise((resolve) => {
        const u = new URL(`${ORCHESTRATOR_URL}/deps`);
        const body = JSON.stringify({ repo, issueId: issueNum, deps: depNums.map(String) });
        const req = http.request({
          method: 'POST', hostname: u.hostname, port: u.port || 9001, path: '/deps',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', e => { log(`⚠ DAG #${issueNum}: ${e.message}`); resolve(); });
        req.write(body); req.end();
      });
      log(`  ✓ #${issueNum} waits for [${depNums.map(n => `#${n}`).join(', ')}]`);
    }
  }

  log(`\n✅ /spec init completed!`);
  const repoUrl = providerType === 'github' ? `https://github.com/${repo}` : `${provider.baseUrl}/${repo}`;
  log(`  Repo       : ${repoUrl}`);
  log(`  Issues     : ${Object.keys(usToIssue).length} created`);
  log(`  Pipeline   : automatic start via webhook`);
}

// CLI dispatch
const cmd = process.argv[2];
if (cmd === 'push') {
  push(process.argv[3]).catch(e => fail(e.message));
} else {
  main().catch(e => fail(e.message));
}
