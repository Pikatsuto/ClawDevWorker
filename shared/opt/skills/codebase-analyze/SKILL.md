---
name: codebase-analyze
description: "Analyzes the codebase structure with an incremental AST index (git-diff based). Only scans files modified since the last index — never the entire project each time. Use this skill BEFORE starting to code on an issue. Commands: /analyze (incremental), /analyze --full (first run), /search <query>, /impact <file>, /symbols <name>."
metadata: {"openclaw":{"emoji":"🔍","requires":{"bins":["node","git"]}}}
user-invocable: true
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# codebase-analyze — Incremental AST index

## Principle: git-diff based, never full-scan except on first run

The index is stored in `$PROJECT_DATA_DIR/$PROJECT_NAME/.coderclaw/codebase-index.json` and **shared between all agents of the same project** (chat, VSCode, workers) via the `project_data` volume.

```
First run on a repo:
  → full scan → complete index stored

Subsequent runs:
  → git diff --name-only $LAST_COMMIT HEAD
  → re-parse only modified files
  → merge delta into existing index
  → never full scan unless --full
```

## Commands

| Command | Action |
|---------|--------|
| `/analyze` | Incremental update (git diff) |
| `/analyze --full` | Forced full scan |
| `/search <query>` | Semantic search in the index |
| `/impact <file>` | Impact radius of a file |
| `/symbols <name>` | Where a symbol is defined / used |

## Usage in a script

```bash
INDEX_SCRIPT="/opt/skills/codebase-analyze/incremental-index.js"

# Incremental update (default — run at the beginning of each task)
node "$INDEX_SCRIPT"

# First run or force
node "$INDEX_SCRIPT" --full

# Search
node "$INDEX_SCRIPT" --search "loginUser"

# Impact radius before modification
node "$INDEX_SCRIPT" --impact "src/auth/login.ts"

# Symbol
node "$INDEX_SCRIPT" --symbols "AuthError"
```

## Automatic workflow in run-worker.sh

```bash
# 1. Incremental index update at worker startup
node /opt/skills/codebase-analyze/incremental-index.js

# 2. Before touching a file → calculate impact radius
node /opt/skills/codebase-analyze/incremental-index.js \
  --impact "src/auth/login.ts"

# 3. After commits → update the index
node /opt/skills/codebase-analyze/incremental-index.js
```

## What the index contains

For each file:
- `imports` — imported modules
- `exports` — exported symbols
- `symbols` — defined functions and classes
- `lines` — line count
- `ext` — extension
- `mtime` — modification timestamp

## Limits

- Lightweight syntactic analysis (regex), not a real AST parser
- Max `INDEX_MAX_FILES` files (default 500) to stay within context
- Circular dependencies are not detected
- No inter-file data flow analysis
