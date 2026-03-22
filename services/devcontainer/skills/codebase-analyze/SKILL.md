---
name: codebase-analyze
description: "Analyzes the codebase structure before any modification: parses TypeScript/JavaScript/Python files, builds a dependency graph, calculates the impact radius of a change. Use this skill BEFORE starting to code on an issue or task. Stores the result in .coderclaw/memory/codebase-index.json."
metadata: {"openclaw":{"emoji":"🔍","requires":{"bins":["node","find","grep"]}}}
user-invocable: true
---

# codebase-analyze — AST Analysis and Impact

## When to use

- **Automatically** at the start of each Forgejo/GitHub worker task
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

For a target file (e.g.: `src/auth/login.ts`):

```javascript
// impact.js — calculates which files import the target file
const index  = JSON.parse(require('fs').readFileSync(process.env.INDEX_FILE));
const target = process.argv[2]; // e.g.: src/auth/login.ts

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

After the analysis, produce a concise summary:

```
## Codebase analysis — ${WORKSPACE}

**Files analyzed:** N
**Impact radius of ${TARGET_FILE}:** M files impacted
  - src/components/LoginForm.vue
  - src/middleware/auth.ts
  - tests/auth.test.ts

**Symbols exported by ${TARGET_FILE}:**
  - loginUser, validateToken, AuthError

**Recommendation:** Modifying these ${M} files requires checking...
```

### 5. Incremental update

The index is only updated for modified files:

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
