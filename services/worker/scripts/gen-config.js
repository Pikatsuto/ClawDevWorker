#!/usr/bin/env node
/**
 * gen-config.js — Generates openclaw.json for the worker (11 specialist roles)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ollamaUrl      = process.env.OLLAMA_BASE_URL    || 'http://ollama:11434';
const ollamaModel    = process.env.OLLAMA_MODEL       || 'qwen3.5:9b';
const ollamaCpu      = process.env.OLLAMA_CPU_URL     || 'http://ollama-cpu:11434';
const workspaceDir   = process.env.OPENCLAW_DIR + '/workspace';
const repo           = process.env.REPO               || '';
const issueId        = process.env.ISSUE_ID           || '';
const issueTitle     = process.env.ISSUE_TITLE        || '';
const issueBody      = process.env.ISSUE_BODY         || '';
const role           = process.env.ROLE               || 'fullstack';
const forgejoUrl     = process.env.FORGEJO_URL        || '';
const forgejoToken   = process.env.FORGEJO_TOKEN      || '';
const parentBranch   = process.env.PARENT_BRANCH      || 'main';
const structured     = process.env.STRUCTURED_CONTEXT || '';
const bmad           = process.env.BMAD_CONTEXT       || '';
const githubToken    = process.env.GITHUB_TOKEN       || '';
const schedulerUrl   = process.env.SCHEDULER_URL      || 'http://localhost:7070';
const projectData    = process.env.PROJECT_DATA_DIR   || '/projects';
const projectName    = process.env.PROJECT_NAME       || repo.replace('/', '_');
const stagedMode     = process.env.STAGED_MODE        !== 'false'; // false = headless direct
const repoName       = repo.split('/')[1]             || 'repo';
const repoWorkspace  = `/workspace/${repoName}`;

// ── System prompt from specialist file ────────────────────────────────────────

const SPECIALISTS_DIR = '/opt/specialists';
const SPECIALIST_ROLES = [
  'architect','frontend','backend','fullstack','devops',
  'qa','doc','marketing','design','product','bizdev',
];

function loadSpecialistPrompt(r) {
  const filePath = path.join(SPECIALISTS_DIR, `${r}.md`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  // Generic fallback
  return `You are an autonomous "${r}" specialist agent on the repo ${repo}.
You are working on issue #${issueId}: "${issueTitle}".
Apply your ${r} expertise to resolve this issue according to the project rules.
Never merge a PR. Commit atomically. Open PRs towards ${parentBranch}.`;
}

// ── Read git_flow config from rules.yaml if present ─────────────────────────
let gitFlowStrategy = 'trunk';
let gitFlowTarget   = 'main';
try {
  const rulesPath = path.join(repoWorkspace, '.coderclaw/rules.yaml');
  if (fs.existsSync(rulesPath)) {
    const rulesContent = fs.readFileSync(rulesPath, 'utf8');
    const stratMatch = rulesContent.match(/strategy:\s*(\w+)/);
    const targetMatch = rulesContent.match(/target_branch:\s*(\S+)/);
    if (stratMatch) gitFlowStrategy = stratMatch[1];
    if (targetMatch) gitFlowTarget = targetMatch[1];
  }
} catch {}

const baseContext = `
# Mission context
Repo: ${repo}
Issue: #${issueId} — ${issueTitle}
Working branch: ${parentBranch}
Your specialist role: ${role}
Git flow: ${gitFlowStrategy} (target: ${gitFlowTarget})
${structured ? `\n# Structured analysis\n${structured}` : ''}
${bmad ? `\n# Project context (BMAD)\n${bmad}` : ''}

# Issue #${issueId}
${issueTitle}

${issueBody}

# Your role in the pipeline

You are the "${role}" specialist. The project uses an RBAC pipeline defined in .coderclaw/rules.yaml.
Multiple specialists work on the SAME branch in sequence (e.g. architect → fullstack → security → qa → doc).
A single PR is submitted to the human with the combined, verified result of all gates.

Focus exclusively on your area of expertise. Do not attempt work outside your role.
If the issue requires expertise outside your role, note it in a commit message — the next gate will handle it.

Previous specialists may have already committed on this branch. Read their commits before starting.
Your job is to add your expertise on top of their work, not redo it.

# MANDATORY git flow
- You work on branch: ${parentBranch} (shared across all gates for this issue)
- 1 commit = 1 logical change, conventional message (feat:, fix:, refactor:, test:, docs:)
- git add on specific files, never git add .
- The branch is preserved on the user repo after merge — never deleted by the agent
- NEVER merge a PR — only the human owner merges
- NEVER push to main or ${gitFlowTarget} directly
- NEVER create a new branch — work on ${parentBranch} only

# Communication via git platform

You communicate ONLY via issue/PR comments on the git platform. No other channel.

## Research — ALWAYS search before asking

You have access to mcp-docs for documentation search.
The search cascade is: DevDocs (self-hosted) → official APIs → web (SearXNG + scraping).
ALWAYS search for answers yourself before asking the human:
1. Search mcp-docs for relevant documentation
2. If no result, search with different keywords or broader terms
3. Read existing code in the repo for patterns and conventions
4. Check existing tests for expected behavior
5. Only if none of the above resolves your question → ask the human

The human is your LAST resort, not your first.

## When truly blocked (after research)
- Comment on issue #${issueId} with your specific questions AND what you already tried
- STOP working and wait — you will be re-triggered when the human responds
- Do NOT guess or make assumptions on ambiguous requirements

# Work ethic

- It is NORMAL to not know something. Search for answers, and if you cannot find them, say so honestly.
- NEVER hallucinate or invent information. If unsure, say "based on my research, I could not confirm this".
- It is perfectly fine to say: "this is not compatible", "this is not feasible", "this cannot be done legally".
  What matters is being FACTUAL, not optimistic.
- NEVER be lazy. If the task is requested and feasible, do it completely regardless of workload.
- NEVER abandon a task that is possible. Persistence is mandatory.
- If you are truly stuck after research, ask for help — that is normal and expected.
- NEVER loop endlessly on a failing approach. If something fails 3 times, try a different strategy.
  If all strategies fail, escalate to the human with what you tried and why it failed.

## PR review comments
- When your PR receives review comments, read ALL of them carefully
- Address each comment with a new commit or an explanation
- Push to the same branch — the PR updates automatically
- If a reviewer requests changes you disagree with, explain your reasoning in a comment

## PR refusal / changes requested
- If the user requests changes on your PR, apply them and push
- If the user closes your PR without merging, STOP — do not reopen or recreate it
- If the user edits the issue description or adds comments, re-read them before continuing

# Resuming work on existing branches

When working on an issue that already has prior work:
1. Check if a branch already exists (features/xxx, feat/xxx, fix/xxx, etc.)
2. If it does, continue from the existing commits — do NOT start from scratch
3. Read existing commits and PR comments to understand context and feedback
4. Create new commits on top of the existing work
5. PR back to the same branch on the user's repo

# Issue dependencies

This issue may depend on other issues (DAG). If the orchestrator assigned you this issue,
all dependencies are already resolved. You can reference other issues in your PR description.
${!stagedMode ? '' : '\n# Staged mode\nYou are working in staged mode — use the staged-diff skill for all file changes.'}
`;

const specialistPrompt = loadSpecialistPrompt(role);
const systemPrompt = `${specialistPrompt}\n\n${baseContext}`;

// ── Allowed tools per role ────────────────────────────────────────────────────

function getAllowedTools(r) {
  const readTools    = ['file.read', 'terminal', 'git', 'mcp-docs'];
  const writeTools   = ['file.write'];
  const devTools     = [...readTools, ...writeTools, 'docker-exec'];
  const reviewTools  = [...readTools]; // read-only for reviewers

  const toolMap = {
    architect:  reviewTools,
    frontend:   devTools,
    backend:    devTools,
    fullstack:  devTools,
    devops:     devTools,
    security:   [...reviewTools, 'file.write'], // Security can annotate
    qa:         [...reviewTools, 'file.write'], // QA can write tests
    doc:        [...readTools, 'file.write'],
    marketing:  reviewTools,
    design:     reviewTools,
    product:    reviewTools,
    bizdev:     reviewTools,
  };
  return toolMap[r] || devTools;
}

function getEnabledSkills(r) {
  const sharedSkills = [
    'session-handoff', 'semantic-memory', 'project-context', 'loop-detect',
  ];
  const devSkills = [
    ...sharedSkills, 'git-flow', 'agent-fanout', 'codebase-analyze',
  ];
  const reviewSkills = [...sharedSkills];

  const skillMap = {
    architect:  reviewSkills,
    frontend:   [...devSkills, 'frontend-design'],
    backend:    devSkills,
    fullstack:  [...devSkills, 'frontend-design'],
    devops:     devSkills,
    security:   [...reviewSkills, 'codebase-analyze'],
    qa:         [...reviewSkills, 'codebase-analyze'],
    doc:        [...sharedSkills, 'codebase-analyze'],
    marketing:  reviewSkills,
    design:     [...reviewSkills, 'frontend-design'],
    product:    reviewSkills,
    bizdev:     reviewSkills,
  };
  return skillMap[r] || devSkills;
}

// ── OpenClaw Config ───────────────────────────────────────────────────────────

const config = {
  gateway: {
    mode:  'local',
    bind:  '127.0.0.1',
    port:  19000,
    auth:  { mode: 'token', token: process.env.GATEWAY_TOKEN },
    nodes: { autoApprove: true },
  },
  agents: {
    defaults: {
      provider:  'ollama',
      model:     ollamaModel,
      workspace: repoWorkspace,
      compaction: {
        memoryFlush: {
          enabled:             true,
          softThresholdTokens: 6000,
          systemPrompt:       'Session nearing compaction. Store durable memories now.',
          prompt:             'Write lasting notes to memory/YYYY-MM-DD.md; reply NO_REPLY if nothing to store.',
        },
      },
      memorySearch: {
        enabled: true,
        sync:    { watch: true },
        store:   { path: `${workspaceDir}/../memory/{agentId}.sqlite` },
      },
    },
    list: [
      {
        id:          `worker-${role}`,
        name:        `Agent ${role.charAt(0).toUpperCase() + role.slice(1)} #${issueId}`,
        systemPrompt,
        provider:    'ollama',
        model:       ollamaModel,
        subagents:   { maxConcurrent: 4 },
        tools: {
          allow: getAllowedTools(role),
          deny:  ['browser', 'file.delete'],
        },
        mcpServers: {
          'mcp-docs': {
            transport: 'stdio',
            command:   'node',
            args:      ['/opt/mcp-docs/src/index.js'],
            env: {
              DEVDOCS_URL:   'http://devdocs:9292',
              SEARXNG_URL:   'http://searxng:8080',
              NODRIVER_URL:  'http://browserless:3000',
              MAX_RESULTS:   '5',
              FETCH_TIMEOUT: '8000',
              ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
            },
          },
        },
        skills: { enabled: getEnabledSkills(role) },
        env: {
          FORGEJO_TOKEN:    forgejoToken,
          FORGEJO_URL:      forgejoUrl,
          REPO:             repo,
          ISSUE_ID:         issueId,
          ISSUE_TITLE:      issueTitle,
          PARENT_BRANCH:    parentBranch,
          SCHEDULER_URL:    schedulerUrl,
          OLLAMA_BASE_URL:  ollamaUrl,
          OLLAMA_CPU_URL:   ollamaCpu,
          OLLAMA_MODEL:     ollamaModel,
          PROJECT_DATA_DIR: projectData,
          PROJECT_NAME:     projectName,
          SURFACE:          'worker',
          STAGED_MODE:      String(stagedMode),
          ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
        },
      },
    ],
  },
  providers: { 'ollama': { baseUrl: ollamaUrl } },
};

const configFile = process.env.CONFIG_FILE;
fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(`openclaw.json generated — role=${role} model=${ollamaModel} agent=${config.agents.list[0].id}`);
