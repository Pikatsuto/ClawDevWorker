---
name: git-provider
description: "Forgejo and GitHub access from Code Server. Read operations (issues, PRs, files) use the agent token. Privileged operations (invite collaborators, setup webhooks, branch protection, delete branch) require the user's personal token and human confirmation. No repo creation from Code Server — use /spec init from the chat instead."
metadata: {"openclaw":{"emoji":"🐙"}}
user-invocable: false
always: false
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# git-provider — Git operations from Code Server

## Token used

- **Read operations** (issues, PRs, files): agent token (automatic)
- **Privileged operations**: user's PERSONAL token via `/token set`

## Privileged operations — REQUIRE HUMAN CONFIRMATION

**IMPORTANT**: The following operations modify repo settings.
ALWAYS ask for explicit confirmation before executing them. Never run them silently.

| Operation | What it does | Confirmation required |
|-----------|-------------|----------------------|
| `provider.addCollaborator(repo, username)` | Invites a user as collaborator | ✅ Yes |
| `provider.createWebhook(repo, opts)` | Adds a webhook to the repo | ✅ Yes |
| `provider.protectBranch(repo, branch)` | Enables branch protection rules | ✅ Yes |
| `provider.deleteBranch(repo, branch)` | Deletes a branch from the remote | ✅ Yes |

**NOT available from Code Server**: `createRepo()` — use `/spec init` from the chat instead.

## Read operations — no confirmation needed

| Operation | What it does |
|-----------|-------------|
| `provider.getIssue(repo, id)` | Get a single issue |
| `provider.listOpenIssues(repo)` | List open issues |
| `provider.listOpenPRs(repo)` | List open PRs |
| `provider.getPR(repo, id)` | Get a single PR |
| `provider.getPRDiff(repo, id)` | Get PR diff |
| `provider.getFileContent(repo, path)` | Read a file from the repo |
| `provider.addComment(repo, issueId, body)` | Comment on an issue/PR |

## Shared module

```javascript
const { loadProviders, getProviderForRepo } = require('/opt/git-provider/index.js');
const providers = loadProviders();
const provider = getProviderForRepo('owner/repo', providers);
```

## User commands

| Command | Action |
|---------|--------|
| `/project status <owner/repo>` | Open issues, PRs, pipeline |
| `/project issues <owner/repo>` | Lists issues with their status |
| `/project prs <owner/repo>` | Lists PRs |
