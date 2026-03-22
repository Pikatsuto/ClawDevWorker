#!/usr/bin/env node
/**
 * gen-config.js — Génère openclaw.json pour le worker (11 rôles spécialistes)
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

// ── System prompt depuis le fichier spécialiste ───────────────────────────────

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
  // Fallback générique
  return `Tu es un agent spécialiste "${r}" autonome sur le repo ${repo}.
Tu travailles sur l'issue #${issueId} : "${issueTitle}".
Applique ton expertise de ${r} pour résoudre cette issue selon les règles du projet.
Ne merge jamais une PR. Committe atomiquement. Ouvre des PRs vers ${parentBranch}.`;
}

const baseContext = `
# Contexte de la mission
Repo : ${repo}
Issue : #${issueId} — ${issueTitle}
Branche principale : ${parentBranch}
${structured ? `\n# Analyse structurée\n${structured}` : ''}
${bmad ? `\n# Contexte projet (BMAD)\n${bmad}` : ''}

# Issue #${issueId}
${issueTitle}

${issueBody}

# Git flow OBLIGATOIRE
- Branches typées : feat/${issueId}-nom, fix/${issueId}-nom, refactor/${issueId}-nom, test/${issueId}-nom, docs/${issueId}-nom
- 1 commit = 1 changement logique, message conventionnel (feat:, fix:, refactor:, test:, docs:)
- git add sur fichiers précis, jamais git add .
- PR vers ${parentBranch} avec "Part of #${issueId}"
- PR principale : ${parentBranch} → main avec "Closes #${issueId}" en fin de mission
- JAMAIS merger une PR
- JAMAIS pousser sur main directement
${!stagedMode ? '' : '\n# Mode staged\nTu travailles en mode staged — utilise le skill staged-diff pour tout changement de fichier.'}
`;

const specialistPrompt = loadSpecialistPrompt(role);
const systemPrompt = `${specialistPrompt}\n\n${baseContext}`;

// ── Outils autorisés par rôle ─────────────────────────────────────────────────

function getAllowedTools(r) {
  const readTools    = ['file.read', 'terminal', 'git', 'mcp-docs'];
  const writeTools   = ['file.write'];
  const devTools     = [...readTools, ...writeTools, 'docker-exec'];
  const reviewTools  = [...readTools]; // lecture seule pour les reviewers

  const toolMap = {
    architect:  reviewTools,
    frontend:   devTools,
    backend:    devTools,
    fullstack:  devTools,
    devops:     devTools,
    security:   [...reviewTools, 'file.write'], // Security peut annoter
    qa:         [...reviewTools, 'file.write'], // QA peut écrire des tests
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

// ── Config OpenClaw ───────────────────────────────────────────────────────────

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
console.log(`openclaw.json généré — rôle=${role} model=${ollamaModel} agent=${config.agents.list[0].id}`);
