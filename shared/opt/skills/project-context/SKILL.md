---
name: project-context
description: "Loads a project's context to work on it in any environment. /project select loads the memory and conventions. /project status shows current issues and PRs. /project code loads the code in read-only mode (explicit). Shares context between chat, VSCode, and worker."
metadata: {"openclaw":{"emoji":"📁","requires":{"bins":["node","git","curl"],"env":["PROJECT_DATA_DIR"]}}}
user-invocable: true
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# project-context — Multi-environment Project Context

## Commands

| Command | Action |
|---------|--------|
| `/project list` | List configured projects |
| `/project select <name>` | Load the project context |
| `/project status` | Current issues and PRs (git API) |
| `/project code` | Load the code in read-only mode (explicit) |
| `/project memory` | Display the project memory |
| `/project rules` | Display the project pipeline rules |

## /project select procedure

### 1. Load the project's .coderclaw/ files

```bash
PROJECT_DATA="${PROJECT_DATA_DIR:-/projects}"
PROJECT_NAME="$1"
PROJECT_DIR="$PROJECT_DATA/$PROJECT_NAME"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project '$PROJECT_NAME' not found. Available projects:"
  ls "$PROJECT_DATA" 2>/dev/null
  exit 1
fi

export PROJECT_NAME
echo "=== Project: $PROJECT_NAME ==="

# Load context files in order
for f in context.yaml architecture.md rules.yaml design.md; do
  FILE="$PROJECT_DIR/$f"
  [ -f "$FILE" ] && echo "--- $f ---" && cat "$FILE" && echo ""
done
```

### 2. Display recent memory

```bash
node /opt/skills/semantic-memory/memory-search.js "" 2>/dev/null | head -30
```

### 3. Display the last handoff

```bash
LAST_HANDOFF=$(ls -t "$PROJECT_DIR/sessions"/*.yaml 2>/dev/null | head -1)
if [ -n "$LAST_HANDOFF" ]; then
  echo "=== Last handoff ==="
  cat "$LAST_HANDOFF"
fi
```

## /project status procedure

Retrieves open issues and PRs via the git provider API:

```bash
# Variables injected by the environment
GIT_REPO="${PROJECT_REPO:-}"  # owner/repo
GIT_URL="${FORGEJO_URL:-https://api.github.com}"
GIT_TOKEN="${FORGEJO_TOKEN:-$GITHUB_TOKEN}"

if [ -z "$GIT_REPO" ]; then
  echo "PROJECT_REPO not configured for this project"
  exit 1
fi

# Open issues
echo "=== Open issues ==="
curl -sf -H "Authorization: token $GIT_TOKEN" \
  "$GIT_URL/api/v1/repos/$GIT_REPO/issues?type=issues&state=open&limit=10" \
  2>/dev/null | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (!Array.isArray(d)) { console.log('API error'); process.exit(1); }
    d.slice(0,10).forEach(i => {
      const labels = (i.labels||[]).map(l=>l.name).join(', ');
      console.log(\`#\${i.number} [\${labels||'no label'}] \${i.title}\`);
    });
  " 2>/dev/null || echo "(API unavailable)"

# Open PRs
echo ""
echo "=== Open Pull Requests ==="
curl -sf -H "Authorization: token $GIT_TOKEN" \
  "$GIT_URL/api/v1/repos/$GIT_REPO/pulls?state=open&limit=10" \
  2>/dev/null | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (!Array.isArray(d)) { console.log('API error'); process.exit(1); }
    d.slice(0,10).forEach(p => {
      console.log(\`PR #\${p.number} [\${p.head?.ref}→\${p.base?.ref}] \${p.title}\`);
    });
  " 2>/dev/null || echo "(API unavailable)"
```

## /project code procedure (explicit)

Loads the code in read-only mode — only on explicit request:

```bash
CLONE_DIR="/tmp/project-readonly-$PROJECT_NAME"

if [ ! -d "$CLONE_DIR" ]; then
  # Read-only clone (shallow, read-only token if available)
  git clone --depth=10 \
    "${GIT_READ_URL:-$GIT_URL/$GIT_REPO.git}" \
    "$CLONE_DIR" 2>/dev/null \
    || { echo "Clone failed — check GIT_READ_URL"; exit 1; }
  echo "✅ Code cloned to $CLONE_DIR (read-only)"
else
  git -C "$CLONE_DIR" pull --quiet
  echo "✅ Code updated"
fi

echo "Files available for reading:"
find "$CLONE_DIR" -type f \
  ! -path "*/.git/*" ! -path "*/node_modules/*" \
  | sed "s|$CLONE_DIR/||" | head -30
echo "(read-only — no modifications possible on this clone)"
```

## Initialize a new project

```bash
/project init <name> <owner/repo>
```

Creates the structure in `PROJECT_DATA`:

```
/projects/<name>/
├── context.yaml      # project metadata
├── architecture.md   # architecture (optional)
├── rules.yaml        # pipeline RBAC
├── design.md         # design guidelines (optional)
├── sessions/         # handoffs
└── memory.db         # semantic memory
```

```bash
mkdir -p "$PROJECT_DATA/$PROJECT_NAME/sessions"
cat > "$PROJECT_DATA/$PROJECT_NAME/context.yaml" << YAML
name: $PROJECT_NAME
repo: $GIT_REPO
description: ""
languages: []
frameworks: []
conventions: ""
created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
YAML

cat > "$PROJECT_DATA/$PROJECT_NAME/rules.yaml" << YAML
pipeline:
  gates: [architect, fullstack, qa, doc]
  require_all: true
specialists:
  marketing:
    triggers: [seo, landing, showcase, copy]
  design:
    triggers: [ui, ux, guidelines, branding]
YAML

echo "✅ Project '$PROJECT_NAME' initialized"
```
