---
name: git-provider
description: "Forgejo and GitHub access from the chat. Uses the USER's token (not the agent token) for operations on their account: creating repos, inviting collaborators, reading issues and PRs. Required by /spec init and /project status. Loads the token from ~/.openclaw/user-tokens/<userId>.json via the user-token skill."
metadata: {"openclaw":{"emoji":"🐙"}}
user-invocable: false
always: false
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# git-provider — Git operations from the chat

## Token used

This skill uses the developer's PERSONAL token (not the agent token).
It must be registered with `/token set` beforehand.

## Available operations

### Repo creation

```javascript
const { execSync } = require('child_process');
const path = require('path');

// Load the user token
const TOKEN_FILE = path.join(process.env.HOME, '.openclaw', 'user-tokens',
  `${process.env.USER_ID || 'default'}.json`);
const tokens = JSON.parse(require('fs').readFileSync(TOKEN_FILE, 'utf8'));
const userToken = tokens.forgejo || tokens.github;
const providerUrl = process.env.GIT_PROVIDER_1_URL || 'http://host-gateway:3000';

// Create repo via Forgejo API
async function createRepo({ name, description = '', private: isPrivate = true }) {
  const payload = JSON.stringify({ name, description, private: isPrivate, auto_init: true });
  // POST /api/v1/user/repos
}

// Invite the agent as a collaborator
async function addCollaborator({ owner, repo, username, permission = 'write' }) {
  // PUT /api/v1/repos/{owner}/{repo}/collaborators/{username}
}

// Create an issue
async function createIssue({ owner, repo, title, body, assignees = [] }) {
  // POST /api/v1/repos/{owner}/{repo}/issues
}

// Get open issues
async function listIssues({ owner, repo, state = 'open' }) {
  // GET /api/v1/repos/{owner}/{repo}/issues
}

// Get PRs
async function listPullRequests({ owner, repo, state = 'open' }) {
  // GET /api/v1/repos/{owner}/{repo}/pulls
}
```

### User commands

| Command | Action |
|---------|--------|
| `/project status <owner/repo>` | Open issues, PRs, pipeline |
| `/project issues <owner/repo>` | Lists issues with their status |
| `/project prs <owner/repo>` | Lists PRs |

## Usage in /spec init

```
1. Check user token availability (via user-token skill)
2. createRepo({ name, private: true })
3. addCollaborator({ username: AGENT_GIT_LOGIN })
4. [BMAD generates the stories]
5. For each story: createIssue({ assignees: [AGENT_GIT_LOGIN] })
6. POST /deps to the orchestrator for the DAG
```

## Shared module

This skill wraps `/opt/git-provider/index.js` which contains the complete
implementation for Forgejo and GitHub (already in the image via COPY).

```javascript
// Load the provider with the user token
const { loadProviders } = require('/opt/git-provider/index.js');
// Override the token with the user's token for this operation
```
