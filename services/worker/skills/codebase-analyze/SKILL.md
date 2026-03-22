---
name: codebase-analyze
description: "Analyzes the codebase structure with an incremental AST index (git-diff based). Only scans files modified since the last index — never the entire project each time. Use this skill BEFORE starting to code on an issue. Commands: /analyze (incremental), /analyze --full (first run), /search <query>, /impact <file>, /symbols <name>."
metadata: {"openclaw":{"emoji":"🔍","requires":{"bins":["node","git"]}}}
user-invocable: true
---

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


# codebase-analyze — AST Analysis and Impact

## When to use

- **Automatically** at the beginning of each Forgejo/GitHub worker task
- **On demand**: `/analyze` or `/analyze src/auth/`
- **Before a refactor** to know the impact radius

## Procedure

### 1. List project files

```bash
WORKSPACE="${WORKSPACE:-$(pwd)}"
INDEX_FILE="${OPENCLAW_DIR:-$HOME/.openclaw}/.coderclaw/memory/codebase-index.json"
mkdir -p "$(dirname "$INDEX_FILE")"

# Code files (excludes node_modules, .git, dist, build)
FILES=$(find "$WORKSPACE" -type f \( \
  -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \
  -o -name "*.vue" -o -name "*.py" -o -name "*.go" \
  -o -name "*.rs" -o -name "*.sh" \
\) \
  ! -path "*/node_modules/*" \
  ! -path "*/.git/*" \
  ! -path "*/dist/*" \
  ! -path "*/build/*" \
  ! -path "*/.next/*" \
  ! -path "*/.nuxt/*" \
| head -200)  # limit to 200 files to stay within context

echo "Files analyzed: $(echo "$FILES" | wc -l)"
```

### 2. Import/export analysis (Node.js)

```javascript
// analyze.js — lightweight AST analysis script
const fs   = require('fs');
const path = require('path');

const WORKSPACE = process.env.WORKSPACE || process.cwd();
const files     = process.argv.slice(2);
const index     = {};

for (const file of files) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(WORKSPACE, file);

    // Extract imports
    const imports = [];
    const importRe = /(?:import|require)\s*(?:\(?\s*['"])([^'"]+)['"]\s*\)?/g;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      imports.push(m[1]);
    }

    // Extract exports
    const exports = [];
    const exportRe = /export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum)\s+(\w+)/g;
    while ((m = exportRe.exec(content)) !== null) {
      exports.push(m[1]);
    }

    // Extract main functions/classes
    const symbols = [];
    const symRe = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)/g;
    while ((m = symRe.exec(content)) !== null) {
      symbols.push(m[1]);
    }

    // Count lines
    const lines = content.split('\n').length;

    index[relPath] = { imports, exports, symbols, lines };
  } catch {}
}

process.stdout.write(JSON.stringify(index, null, 2));
```

```bash
# Run the analysis
node /opt/skills/codebase-analyze/analyze.js $FILES > "$INDEX_FILE"
echo "Index written: $INDEX_FILE"
```

### 3. Impact radius calculation

For a target file (e.g., `src/auth/login.ts`):

```javascript
// impact.js — calculates which files import the target file
const index  = JSON.parse(require('fs').readFileSync(process.env.INDEX_FILE));
const target = process.argv[2]; // e.g., src/auth/login.ts

const impacted = [];
for (const [file, info] of Object.entries(index)) {
  const importsTarget = info.imports.some(imp => {
    // Simple relative resolution
    return imp.includes(target.replace('.ts','').replace('.js','')) ||
           imp.endsWith(target.split('/').pop().replace('.ts',''));
  });
  if (importsTarget) impacted.push(file);
}

console.log(JSON.stringify({ target, impacted, count: impacted.length }));
```

### 4. Summary for the agent

After analysis, produce a concise summary:

```
## Codebase analysis — ${WORKSPACE}

**Files analyzed:** N
**Impact radius of ${TARGET_FILE}:** M impacted files
  - src/components/LoginForm.vue
  - src/middleware/auth.ts
  - tests/auth.test.ts

**Symbols exported by ${TARGET_FILE}:**
  - loginUser, validateToken, AuthError

**Recommendation:** Modifying these ${M} files requires verifying...
```

### 5. Incremental update

The index is updated only for modified files:

```bash
# Files modified since the last commit
CHANGED=$(git -C "$WORKSPACE" diff --name-only HEAD 2>/dev/null || echo "")
if [ -n "$CHANGED" ]; then
  node /opt/skills/codebase-analyze/analyze.js $CHANGED >> "$INDEX_FILE.patch"
fi
```

## Commands

| Command | Action |
|---------|--------|
| `/analyze` | Analyze the entire workspace |
| `/analyze src/auth/` | Analyze a specific directory |
| `/impact src/auth/login.ts` | Calculate the impact radius of a file |
| `/symbols ClassName` | Search where a symbol is used |
