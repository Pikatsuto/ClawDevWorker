---
name: git-flow
description: "Manages clean git flow for each code modification. Use this skill for EVERY file write — immediate atomic commit after each logical change. Creates feature/ or fix/ branches depending on the type of change. Opens one PR per logical unit of work once commits are pushed."
metadata: {"openclaw":{"emoji":"🌿","requires":{"bins":["git","curl","jq"],"env":["FORGEJO_TOKEN","FORGEJO_URL","REPO","ISSUE_ID","PARENT_BRANCH"]}}}
user-invocable: false
---

# git-flow — Clean git flow

## Absolute rules

- **One commit per logical change** — never a big catch-all commit
- **One branch per unit of work** — feature, fix, refactor, test, docs
- **One PR per branch** — never multi-topic PRs
- **You NEVER merge yourself** — open the PR, that's it
- **Conventional commit messages**: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`

## Branch structure

```
${PARENT_BRANCH}                    ← main branch of the issue (agent/issue-N-slug)
  ├── feat/${ISSUE_ID}-short-name   ← new feature
  ├── fix/${ISSUE_ID}-short-name    ← bug fix
  ├── refactor/${ISSUE_ID}-name     ← refactoring without functional change
  ├── test/${ISSUE_ID}-name         ← adding/fixing tests
  └── docs/${ISSUE_ID}-name         ← documentation only
```

## Workflow per unit of work

### 1. Identify the type of change

Before touching the code, determine:
- `feat`: new feature, new behavior
- `fix`: bug fix, broken behavior
- `refactor`: improvement without functional change
- `test`: adding or fixing tests
- `docs`: documentation, comments, README

### 2. Create the working branch

```bash
WORK_TYPE="feat"        # feat | fix | refactor | test | docs
WORK_SLUG="short-name"  # 2-4 kebab-case words describing the change
WORK_BRANCH="${WORK_TYPE}/${ISSUE_ID}-${WORK_SLUG}"

# Start from the main branch of the issue
git checkout "${PARENT_BRANCH}" 2>/dev/null || git checkout main
git checkout -b "${WORK_BRANCH}"
```

### 3. Code and commit atomically

**After EACH logical change** (one file, one component, one function):

```bash
# Stage ONLY the files for this change
git add path/to/file.ext

# Conventional message
git commit -m "feat(auth): add JWT validation in middleware

- Check token expiration
- Extract userId from payload
- Return 401 if invalid

Refs #${ISSUE_ID}"
```

**Never do** `git add .` unless all modified files are part of the same atomic change.

### 4. Push and open the PR

```bash
git push origin "${WORK_BRANCH}"

# Create the PR targeting the main branch of the issue (not main)
curl -sf -X POST \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  -H "Content-Type: application/json" \
  "${FORGEJO_URL}/api/v1/repos/${REPO}/pulls" \
  -d "$(jq -n \
    --arg title "${WORK_TYPE}(${WORK_SLUG}): short description" \
    --arg body  "## Changes\n\n- Description of the change\n\n## Why\n\nRefers to issue #${ISSUE_ID}\n\nPart of #${ISSUE_ID}" \
    --arg head  "${WORK_BRANCH}" \
    --arg base  "${PARENT_BRANCH}" \
    '{title: $title, body: $body, head: $head, base: $base}'
  )"
```

### 5. Return to the main branch for the next task

```bash
git checkout "${PARENT_BRANCH}"
```

## Handling review comments

If a PR receives review comments:

```bash
# Fetch review comments
PR_REVIEWS=$(curl -sf \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  "${FORGEJO_URL}/api/v1/repos/${REPO}/pulls/${PR_NUMBER}/reviews")

# Switch back to the same branch
git checkout "${WORK_BRANCH}"
git pull origin "${WORK_BRANCH}"

# Fix, commit
git add fixed-file.ext
git commit -m "fix(review): fix X per review from @reviewer

${FIX_DETAIL}

Addresses review on #${PR_NUMBER}"

git push origin "${WORK_BRANCH}"
```

## What you do at the end of an issue

Once all work PRs are opened:

```bash
# Main PR for the issue — aggregates the work branches
curl -sf -X POST \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  -H "Content-Type: application/json" \
  "${FORGEJO_URL}/api/v1/repos/${REPO}/pulls" \
  -d "$(jq -n \
    --arg title "Issue #${ISSUE_ID}: ${ISSUE_TITLE}" \
    --arg body  "Closes #${ISSUE_ID}\n\n## Summary\n\n${SUMMARY}\n\n## Work PRs\n\n${PR_LIST}" \
    --arg head  "${PARENT_BRANCH}" \
    --arg base  "main" \
    '{title: $title, body: $body, head: $head, base: $base}'
  )"
```

## Concrete example

Issue #42: "Add JWT authentication"

```
main
 └── agent/issue-42-add-jwt-auth         ← main PR → main
       ├── feat/42-jwt-validation         ← atomic PR: JWT middleware
       ├── feat/42-refresh-token          ← atomic PR: refresh token
       ├── test/42-jwt-unit-tests         ← atomic PR: unit tests
       └── docs/42-auth-api-docs          ← atomic PR: API documentation
```

Each atomic PR is opened toward `agent/issue-42-add-jwt-auth`.
The main PR is opened toward `main` with `Closes #42`.
