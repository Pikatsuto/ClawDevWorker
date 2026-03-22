---
name: session-handoff
description: "Generates a portable handoff document to resume a session in any environment. Use /handoff to save the current state and /resume to resume. Handoffs are shared between chat, VSCode, and worker via the project_data volume."
metadata: {"openclaw":{"emoji":"🤝","requires":{"bins":["node","date"]}}}
user-invocable: true
---

# session-handoff — Cross-environment portability

## Commands

| Command | Action |
|---------|--------|
| `/handoff` | Generates the handoff for the current session |
| `/handoff "context"` | Handoff with a context note |
| `/resume` | Lists available handoffs |
| `/resume latest` | Resumes the most recent handoff |
| `/resume <id>` | Resumes a specific handoff |

## /handoff procedure

### 1. Collect the session state

The agent summarizes in a few lines:
- Current task and what has been accomplished
- Decisions made and why
- Modified files (and their state: staged / committed / in progress)
- Next steps
- Important context not to forget

### 2. Generate the YAML file

```javascript
const fs   = require('fs');
const path = require('path');

const PROJECT_DATA = process.env.PROJECT_DATA_DIR || '/projects';
const PROJECT_NAME = process.env.PROJECT_NAME || 'default';
const SURFACE      = process.env.SURFACE || 'unknown'; // chat | vscode | worker

const handoffDir = path.join(PROJECT_DATA, PROJECT_NAME, 'sessions');
fs.mkdirSync(handoffDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slug      = (process.env.HANDOFF_CONTEXT || 'session').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').slice(0, 30);
const filename  = `${timestamp}-${slug}.yaml`;
const filepath  = path.join(handoffDir, filename);

const handoff = {
  id:        `${timestamp}-${slug}`,
  created:   new Date().toISOString(),
  surface:   SURFACE,
  project:   PROJECT_NAME,
  context:   process.env.HANDOFF_CONTEXT || '',

  // To be filled by the agent
  task: {
    description: '${TASK_DESCRIPTION}',
    progress:    '${TASK_PROGRESS}',
    status:      '${TASK_STATUS}',  // in-progress | blocked | ready-for-next
  },

  decisions: [
    // { what: '...', why: '...', when: '...' }
  ],

  files: {
    modified: [],  // modified files not yet committed
    staged:   [],  // files in the staged folder
    committed: [], // files committed in this session
  },

  git: {
    branch:      '${GIT_BRANCH}',
    lastCommit:  '${LAST_COMMIT}',
  },

  next_steps: [
    // '...'
  ],

  memory_snapshot: '${MEMORY_SUMMARY}',  // summary of important decisions
};

fs.writeFileSync(filepath, require('./yaml-serialize')(handoff));
console.log(`Handoff saved: ${filepath}`);
console.log(`ID: ${handoff.id}`);
```

### 3. Collect git state automatically

```bash
GIT_BRANCH=$(git -C "$WORKSPACE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
LAST_COMMIT=$(git -C "$WORKSPACE" log -1 --oneline 2>/dev/null || echo "")
MODIFIED=$(git -C "$WORKSPACE" status --short 2>/dev/null | head -20)
export GIT_BRANCH LAST_COMMIT MODIFIED
```

## /resume procedure

### 1. List available handoffs

```bash
PROJECT_DATA="${PROJECT_DATA_DIR:-/projects}"
PROJECT_NAME="${PROJECT_NAME:-default}"
SESSIONS_DIR="$PROJECT_DATA/$PROJECT_NAME/sessions"

echo "=== Available handoffs ==="
ls -t "$SESSIONS_DIR"/*.yaml 2>/dev/null | head -10 | while read f; do
  ID=$(basename "$f" .yaml)
  SURFACE=$(grep 'surface:' "$f" | head -1 | awk '{print $2}')
  CONTEXT=$(grep 'context:' "$f" | head -1 | cut -d: -f2-)
  echo "  $ID ($SURFACE) $CONTEXT"
done
```

### 2. Load a handoff

```bash
ID="${1:-latest}"

if [ "$ID" = "latest" ]; then
  FILE=$(ls -t "$SESSIONS_DIR"/*.yaml 2>/dev/null | head -1)
else
  FILE="$SESSIONS_DIR/$ID.yaml"
fi

if [ ! -f "$FILE" ]; then
  echo "Handoff not found: $ID"
  exit 1
fi

echo "=== Resuming session ==="
cat "$FILE"
```

After reading the file, the agent resumes exactly where the previous session left off:
- It reloads the git context (branch, recent commits)
- It picks up staged files if present
- It continues the next_steps in order

## Cross-environment sharing

The `project_data` volume is mounted on all services:
- `/projects/<name>/sessions/` — handoffs
- `/projects/<name>/memory.db` — semantic memory
- `/projects/<name>/rules.yaml` — pipeline rules

Thus a handoff created in VSCode is immediately available in the chat and vice-versa.
