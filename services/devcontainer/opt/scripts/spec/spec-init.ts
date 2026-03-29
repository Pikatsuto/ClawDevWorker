/**
 * spec-init.ts — /spec init orchestrator in the CHAT service
 *
 * Full flow:
 *   1. Verify user token (via user-tokens/<userId>.json)
 *   2. Detect provider (forgejo or github) from the token
 *   3. Create the repo on the USER's account (private by default)
 *   4. Invite the agent account as a collaborator (write)
 *   5. Configure webhook -> orchestrator
 *   6. Protect the main branch (1 required approval)
 *   7. Clone the repo locally into /tmp/spec-<repoName>
 *   8. Copy .coderclaw/rules.yaml + minimal devcontainer.json placeholder
 *   9. BMAD generates artifacts (interactive or batch)
 *  10. Commit everything to main
 *  11. Parse USER_STORIES.md -> issues with dependencies
 *  12. POST /deps to the orchestrator -> DAG
 *  13. Webhooks trigger the RBAC pipeline
 *
 * CLI usage (called by the skill):
 *   node spec-init.js --name <name> [--provider forgejo|github] [--brief <brief.md>] [--public]
 *   node spec-init.js push <owner/repo>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execSync } from 'node:child_process';
import { loadProviders } from '#shared/git-provider/index.js';

// ── Config ──────────────────────────────────────────────────────────────────

const USER_ID = process.env.USER_ID ?? 'default';
const AGENT_LOGIN = process.env.AGENT_GIT_LOGIN ?? 'agent';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://openclaw-agent:9001';
const TOKEN_DIR = join(process.env.HOME ?? '/root', '.openclaw', 'user-tokens');
const TOKEN_FILE = join(TOKEN_DIR, `${USER_ID}.json`);

const RULES_TEMPLATE = '/opt/devcontainer/defaults/coderclaw-rules.yaml';
const BMAD_OUTPUT_DIR = process.env.BMAD_OUTPUT_DIR ?? '/tmp/bmad-output';

const logMsg = (msg: string) => console.log(`[spec-init] ${msg}`);
const fail = (msg: string): never => { console.error(`[spec-init] ${msg}`); process.exit(1); };

// ── Load git providers ─────────────────────────────────────��────────────────

let gitProviders: ReturnType<typeof loadProviders>;
try { gitProviders = loadProviders(); }
catch (e) { fail(`Failed to load git providers: ${(e as Error).message}`); }

const getProvider = (providerHint?: string) => {
  if (providerHint) {
    const found = [...gitProviders.values()].find(p => p.type === providerHint);
    if (!found) return fail(`Provider "${providerHint}" not configured. Available: ${[...gitProviders.values()].map(p => p.type).join(', ')}`);
    return found;
  }
  const first = [...gitProviders.values()][0];
  if (!first) return fail('No git provider configured.');
  return first;
};

// ── 1. Load user token ──────────────────────────────────────────────────────

const loadUserToken = (): Record<string, string> => {
  if (!existsSync(TOKEN_FILE)) {
    fail('Git token not configured.\nUse /token set <token> to register your Forgejo/GitHub token.');
  }
  return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as Record<string, string>;
};

const detectProviderFromToken = (tokens: Record<string, string>, providerHint?: string): string => {
  if (providerHint) return providerHint;
  if (tokens.github && [...gitProviders.values()].some(p => p.type === 'github')) return 'github';
  if (tokens.forgejo) return 'forgejo';
  return [...gitProviders.values()][0]?.type ?? 'forgejo';
};

// ── Main ────────────────────────────────────────────────────────────────────

const main = async () => {
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf('--name');
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
  const brief = args.includes('--brief') ? args[args.indexOf('--brief') + 1] : undefined;
  const isPublic = args.includes('--public');
  const providerIdx = args.indexOf('--provider');
  const providerHint = providerIdx >= 0 ? args[providerIdx + 1] : undefined;

  if (!name) return fail('Usage: node spec-init.js --name <name> [--provider forgejo|github] [--brief <brief.md>] [--public]');

  logMsg(`\n=== /spec init "${name}" ===\n`);

  const tokens = loadUserToken();
  const providerType = detectProviderFromToken(tokens, providerHint);
  const provider = getProvider(providerType);
  const userToken = tokens[providerType] ?? tokens.forgejo ?? tokens.github;

  if (!userToken) fail(`No token found for provider "${providerType}".`);
  logMsg(`Provider: ${providerType}`);

  // 2. Get user login
  let userLogin = '';
  try {
    const baseUrl = providerType === 'github' ? 'https://api.github.com' : provider.baseUrl!;
    const authHeader = providerType === 'github' ? `Bearer ${userToken}` : `token ${userToken}`;
    const userData = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const u = new URL(`${baseUrl}${providerType === 'github' ? '' : '/api/v1'}/user`);
      const reqLib = u.protocol === 'https:' ? httpsRequest : httpRequest;
      const opts = {
        method: 'GET', hostname: u.hostname,
        port: u.port ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        headers: { Authorization: authHeader, Accept: 'application/json', 'User-Agent': 'clawdevworker/1.0' },
      };
      const req = reqLib(opts, res => {
        let d = '';
        res.on('data', (c: string) => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d) as Record<string, unknown>); } catch { resolve({}); } });
      });
      req.on('error', reject);
      req.end();
    });
    userLogin = userData.login as string;
    if (!userLogin) fail('Failed to authenticate — check your token.');
  } catch (e) {
    fail(`Authentication error: ${(e as Error).message}`);
  }
  logMsg(`Logged in as @${userLogin}`);

  // 3. Create the repo
  logMsg(`Creating repo "${name}" on your account...`);
  try {
    const repo = await provider.createRepo(name, { private: !isPublic, description: 'Project initialized via clawdevworker' });
    logMsg(`Repo created: ${(repo.full_name as string) ?? `${userLogin}/${name}`}`);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (msg.includes('409') || msg.includes('already')) {
      logMsg('Repo already exists — using existing repo');
    } else {
      logMsg(`Repo creation: ${msg} — may already exist, continuing...`);
    }
  }
  const owner = userLogin;

  // 4. Invite the agent
  logMsg(`Inviting @${AGENT_LOGIN} as collaborator...`);
  try {
    await provider.addCollaborator(`${owner}/${name}`, AGENT_LOGIN, providerType === 'github' ? 'push' : 'write');
    logMsg(`@${AGENT_LOGIN} invited as collaborator`);
  } catch (e) {
    logMsg(`Invitation failed: ${(e as Error).message} — add @${AGENT_LOGIN} manually`);
  }

  // 5. Configure the webhook
  logMsg('Configuring webhook...');
  const webhookUrl = 'http://openclaw-agent:9000/webhook';
  try {
    await provider.createWebhook(`${owner}/${name}`, {
      url: webhookUrl,
      secret: process.env.GIT_PROVIDER_1_WEBHOOK_SECRET ?? '',
      events: ['issues', 'issue_comment', 'pull_request'],
    });
    logMsg(`Webhook configured -> ${webhookUrl}`);
  } catch (e) {
    logMsg(`Webhook failed: ${(e as Error).message} — configure it manually`);
  }

  // 6. Protect the main branch
  logMsg('Setting up branch protection on main...');
  try {
    await provider.protectBranch(`${owner}/${name}`, 'main', { requiredApprovals: 1 });
    logMsg('Branch protection enabled (1 required approval)');
  } catch (e) {
    logMsg(`Branch protection failed: ${(e as Error).message} — configure it manually`);
  }

  // 7. If batch mode, launch BMAD headless
  if (brief) {
    logMsg(`\nBatch mode — brief: ${brief}`);
    if (!existsSync(brief)) fail(`Brief not found: ${brief}`);
    mkdirSync(`${BMAD_OUTPUT_DIR}/planning-artifacts`, { recursive: true });
    copyFileSync(brief, `${BMAD_OUTPUT_DIR}/planning-artifacts/product-brief.md`);
    logMsg('Brief copied — the BMAD agent will generate the spec autonomously');
    logMsg('Run /bmad prd then /bmad arch then /bmad stories, or /bmad full for everything at once');
  } else {
    logMsg('\nInteractive mode — Run /bmad full to start the spec');
    logMsg(`Once the spec is complete, run /spec push ${owner}/${name} to create the issues`);
  }

  // Save context for /spec push
  const ctxFile = join(process.env.HOME ?? '/root', '.openclaw', 'spec-context.json');
  mkdirSync(dirname(ctxFile), { recursive: true });
  writeFileSync(ctxFile, JSON.stringify({
    owner, repoName: name, providerType, fullName: `${owner}/${name}`,
    createdAt: new Date().toISOString(),
  }, null, 2));

  const repoUrl = providerType === 'github'
    ? `https://github.com/${owner}/${name}`
    : `${provider.baseUrl}/${owner}/${name}`;
  logMsg(`\nContext saved. Repo: ${repoUrl}`);
};

// ── "push" mode — called after BMAD ────────────────────────────────────────

const push = async (ownerRepo: string) => {
  const [owner, repoName] = ownerRepo.split('/');
  if (!owner || !repoName) fail('Expected format: owner/repo');

  // Validate user token exists (throws if not configured)
  loadUserToken();

  const ctxFile = join(process.env.HOME ?? '/root', '.openclaw', 'spec-context.json');
  let providerType = 'forgejo';
  if (existsSync(ctxFile)) {
    const ctx = JSON.parse(readFileSync(ctxFile, 'utf8')) as Record<string, unknown>;
    providerType = (ctx.providerType as string) ?? 'forgejo';
  }
  const provider = getProvider(providerType);

  // Clone
  logMsg('Cloning repo...');
  const cloneDir = `/tmp/spec-${repoName}-${Date.now()}`;
  const cloneUrl = provider.cloneUrl(`${owner}/${repoName}`);
  execSync(`git clone ${cloneUrl} ${cloneDir}`, { stdio: 'pipe' });
  execSync(`git -C ${cloneDir} config user.email "agent@clawdevworker.local"`);
  execSync(`git -C ${cloneDir} config user.name "CoderClaw Agent"`);

  // Create base structure
  mkdirSync(`${cloneDir}/.coderclaw`, { recursive: true });
  mkdirSync(`${cloneDir}/.devcontainer`, { recursive: true });
  mkdirSync(`${cloneDir}/docs/spec`, { recursive: true });

  if (existsSync(RULES_TEMPLATE)) {
    copyFileSync(RULES_TEMPLATE, `${cloneDir}/.coderclaw/rules.yaml`);
  } else {
    writeFileSync(`${cloneDir}/.coderclaw/rules.yaml`,
      'pipeline:\n  gates: [architect, fullstack, security, qa, doc]\n  max_retries: 3\n  retry_upgrade: true\n');
  }

  // devcontainer.json placeholder — devcontainer-init skill generates the real one after BMAD
  if (!existsSync(`${cloneDir}/.devcontainer/devcontainer.json`)) {
    writeFileSync(`${cloneDir}/.devcontainer/devcontainer.json`,
      JSON.stringify({
        name: repoName, image: 'mcr.microsoft.com/devcontainers/base:alpine',
        customizations: { vscode: { extensions: [] } },
        postCreateCommand: '# Generated by /spec init — run /devcontainer init to customize',
      }, null, 2));
  }

  // Copy workflows (auto-promote + auto-release)
  const WORKFLOWS_DIR = '/opt/devcontainer/defaults/workflows';
  if (existsSync(WORKFLOWS_DIR)) {
    mkdirSync(`${cloneDir}/.github/workflows`, { recursive: true });
    for (const wf of readdirSync(WORKFLOWS_DIR)) {
      if (wf.endsWith('.yml') || wf.endsWith('.yaml')) {
        copyFileSync(`${WORKFLOWS_DIR}/${wf}`, `${cloneDir}/.github/workflows/${wf}`);
        logMsg(`${wf} workflow copied`);
      }
    }
  }

  // Copy BMAD artifacts
  const srcDir = `${BMAD_OUTPUT_DIR}/planning-artifacts`;
  if (!existsSync(srcDir)) {
    fail(`BMAD artifacts not found in ${srcDir}.\nRun /bmad full first.`);
  }
  for (const file of ['product-brief.md', 'PRD.md', 'ARCHITECTURE.md', 'USER_STORIES.md']) {
    const src = join(srcDir, file);
    if (existsSync(src)) {
      copyFileSync(src, `${cloneDir}/docs/spec/${file}`);
      logMsg(`${file} copied`);
    } else {
      logMsg(`${file} missing — skipped`);
    }
  }

  // Commit and push
  logMsg('Committing and pushing spec...');
  execSync(`git -C ${cloneDir} add -A`);
  execSync(`git -C ${cloneDir} commit -m "chore: initialize project spec via BMAD"`);
  execSync(`git -C ${cloneDir} push origin main`);
  logMsg('Spec committed to main');

  // Create issues
  const storiesFile = `${BMAD_OUTPUT_DIR}/planning-artifacts/USER_STORIES.md`;
  if (!existsSync(storiesFile)) {
    logMsg('USER_STORIES.md missing — issues not created');
    return;
  }

  const content = readFileSync(storiesFile, 'utf8');
  const stories: Array<{ usNum: string; fullTitle: string; body: string; deps: string[] }> = [];
  const sections = content.split(/(?=^## US-)/m).filter(s => /^## US-\d+/.test(s.trim()));

  for (const section of sections) {
    const lines = section.split('\n');
    const headerLine = lines[0]!.trim();
    const hm = headerLine.match(/^## (US-(\d+)[^\n]*)/);
    if (!hm) continue;

    const fullTitle = hm[1]!.trim();
    const usNum = hm[2]!;
    const bodyLines = lines.slice(1);
    const deps: string[] = [];
    for (const line of bodyLines) {
      const dm = line.match(/\*\*[Dd](?:épend de|epends on)\s*:\*\*\s*(.+)/);
      if (dm) {
        dm[1]!.split(',').forEach(d => {
          const nm = d.trim().match(/US-(\d+)/);
          if (nm) deps.push(nm[1]!);
        });
      }
    }
    stories.push({ usNum, fullTitle, body: bodyLines.join('\n').trim(), deps });
  }

  if (!stories.length) {
    logMsg('No stories parsed from USER_STORIES.md');
    return;
  }

  logMsg(`\nCreating ${stories.length} issues on ${owner}/${repoName}...`);
  const usToIssue: Record<string, number> = {};
  const repo = `${owner}/${repoName}`;

  for (const story of stories) {
    const bodyText = story.body +
      (story.deps.length ? `\n\n---\n**Depends on:** ${story.deps.map(n => `#${n}`).join(', ')}` : '') +
      '\n\n*Generated by `/spec init`*';

    try {
      const r = await provider._req('POST', `/repos/${owner}/${repoName}/issues`,
        { title: story.fullTitle, body: bodyText, assignees: [AGENT_LOGIN] });

      const data = r.data as Record<string, unknown>;
      if (data?.number) {
        usToIssue[story.usNum] = data.number as number;
        logMsg(`  #${data.number} ${story.fullTitle}` +
          (story.deps.length ? ` [depends on: ${story.deps.map(n => `US-${n}`).join(', ')}]` : ''));
      } else {
        logMsg(`  ${story.fullTitle}: ${JSON.stringify(data).slice(0, 100)}`);
      }
    } catch (e) {
      logMsg(`  ${story.fullTitle}: ${(e as Error).message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Register the DAG in the orchestrator
  const hasDeps = stories.filter(s => s.deps.length > 0);
  if (hasDeps.length > 0) {
    logMsg(`\nRegistering ${hasDeps.length} dependencies...`);
    for (const story of hasDeps) {
      const issueNum = usToIssue[story.usNum];
      if (!issueNum) continue;
      const depNums = story.deps.map(usNum => usToIssue[usNum]).filter((n): n is number => n !== undefined);
      if (!depNums.length) continue;

      await new Promise<void>((resolve) => {
        const u = new URL(`${ORCHESTRATOR_URL}/deps`);
        const body = JSON.stringify({ repo, issueId: issueNum, deps: depNums.map(String) });
        const req = httpRequest({
          method: 'POST', hostname: u.hostname, port: u.port ? parseInt(u.port) : 9001, path: '/deps',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString() },
        }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', e => { logMsg(`DAG #${issueNum}: ${(e as Error).message}`); resolve(); });
        req.write(body);
        req.end();
      });
      logMsg(`  #${issueNum} waits for [${depNums.map(n => `#${n}`).join(', ')}]`);
    }
  }

  logMsg('\n/spec init completed!');
  const repoUrl = providerType === 'github' ? `https://github.com/${repo}` : `${provider.baseUrl}/${repo}`;
  logMsg(`  Repo       : ${repoUrl}`);
  logMsg(`  Issues     : ${Object.keys(usToIssue).length} created`);
  logMsg('  Pipeline   : automatic start via webhook');
};

// CLI dispatch
const cmd = process.argv[2];
if (cmd === 'push') {
  push(process.argv[3]!).catch(e => fail((e as Error).message));
} else {
  main().catch(e => fail((e as Error).message));
}
