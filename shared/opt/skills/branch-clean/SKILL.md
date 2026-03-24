---
name: branch-clean
description: "Interactive branch cleanup for a repo. Lists branches with age and merge status, pre-filters using rules from .coderclaw/rules.yaml (auto_delete_patterns, protected_patterns), and asks for human confirmation on ambiguous branches."
metadata: {"openclaw":{"emoji":"🧹"}}
user-invocable: true
trigger: "/clean"
always: false
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# branch-clean — Interactive branch cleanup

## Trigger

`/clean <owner/repo>` or `/clean` (uses current project context)

## Flow

### 1. Load rules

Read `.coderclaw/rules.yaml` from the repo to get:
- `branch_cleanup.auto_delete_patterns` — branches to delete without asking (e.g. `agent/*`, `bot/*`)
- `branch_cleanup.protected_patterns` — branches to never delete (e.g. `main`, `develop`, `release/*`)

### 2. List branches

Use `provider.listBranches(repo)` to get all remote branches with metadata.

### 3. Categorize

For each branch, determine:
- **Protected**: matches `protected_patterns` → skip, show as "🔒 protected"
- **Auto-delete**: matches `auto_delete_patterns` AND is fully merged → mark for deletion
- **Ambiguous**: doesn't match either pattern → ask the user

### 4. Show summary

Display a table:
```
🔒 Protected (won't touch):
  main, develop, release/1.0

🗑️ Auto-delete (merged agent branches):
  agent/issue-42-fix-auth
  agent/issue-55-add-tests
  bot/review-pr-12

❓ Needs your decision:
  features/dark-mode (3 weeks old, not merged)
  experiment/new-api (2 months old, merged into develop)
```

### 5. Confirm

Ask: "Delete the auto-delete branches? (yes/no)"
Then for each ambiguous branch, ask individually.

### 6. Execute

For each confirmed deletion:
```javascript
await provider.deleteBranch(repo, branchName);
```

**IMPORTANT**: Always ask for confirmation before deleting any branch. Never delete protected branches.

## Pattern matching

Patterns use simple glob syntax:
- `agent/*` matches `agent/issue-42-fix-auth`
- `release/*` matches `release/1.0.0`
- `main` matches only `main`

## Without rules.yaml

If no rules file exists, use sensible defaults:
- Protected: `main`, `develop`, `master`
- Auto-delete: `agent/*`, `bot/*`
- Everything else: ask
