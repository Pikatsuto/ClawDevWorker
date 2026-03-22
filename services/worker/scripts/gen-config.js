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

const baseContext = `
# Mission context
Repo: ${repo}
Issue: #${issueId} — ${issueTitle}
Main branch: ${parentBranch}
${structured ? `\n# Structured analysis\n${structured}` : ''}
${bmad ? `\n# Project context (BMAD)\n${bmad}` : ''}

# Issue #${issueId}
${issueTitle}

${issueBody}

# MANDATORY git flow
- Typed branches: feat/${issueId}-name, fix/${issueId}-name, refactor/${issueId}-name, test/${issueId}-name, docs/${issueId}-name
- 1 commit = 1 logical change, conventional message (feat:, fix:, refactor:, test:, docs:)
- git add on specific files, never git add .
- PR towards ${parentBranch} with "Part of #${issueId}"
- Main PR: ${parentBranch} → main with "Closes #${issueId}" at end of mission
- NEVER merge a PR
- NEVER push to main directly

# Resuming work on existing branches

When asked to continue work on an existing issue or branch:
1. Check if the branch already exists on the user's repo (features/xxx, feat/xxx, fix/xxx)
2. If it does, fork it and continue from where the previous agent left off
3. Read the existing commits and PR comments to understand the context
4. Create new commits on top of the existing work
5. PR back to the same branch on the user's repo
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
    'session-handoff', 'semantic-memory', 'project-context', 'frontend-design',
  ];
  const devSkills = [
    ...sharedSkills, 'docker-exec', 'git-flow', 'agent-fanout', 'codebase-analyze',
    ...(stagedMode ? ['staged-diff'] : []),
  ];
  const reviewSkills = [...sharedSkills];

  const skillMap = {
    architect:  reviewSkills,
    frontend:   [...devSkills],
    backend:    devSkills,
    fullstack:  devSkills,
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
