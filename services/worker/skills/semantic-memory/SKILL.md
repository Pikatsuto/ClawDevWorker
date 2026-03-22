---
name: semantic-memory
description: "Shared semantic memory per project across all agents and environments. Stores decisions, conventions, and context in a searchable SQLite. Use /remember to retrieve past decisions, /learn to memorize new ones."
metadata: {"openclaw":{"emoji":"🧠","requires":{"bins":["node","sqlite3"]}}}
user-invocable: true
---

# semantic-memory — Shared Project Memory

## Principle

All agents (chat, VSCode, worker) of the same project share the same SQLite memory.
It is persisted in `/projects/<name>/memory.db` on the shared volume.

## Commands

| Command | Action |
|---------|--------|
| `/remember <query>` | Search project memory |
| `/learn <fact>` | Memorize a fact or decision |
| `/memory list` | List recent entries |
| `/memory project` | Summary of all project context |

## Memory structure

```sql
CREATE TABLE memory (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  project   TEXT NOT NULL,
  category  TEXT NOT NULL,  -- decision | convention | context | bug | fix
  content   TEXT NOT NULL,
  tags      TEXT,           -- JSON array of tags
  source    TEXT,           -- who wrote it: chat | vscode | worker-qa | etc.
  created   TEXT NOT NULL,
  embedding TEXT            -- simplified vector for semantic search
);
```

## Procedure /learn

```javascript
// memory-write.js
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const PROJECT_DATA = process.env.PROJECT_DATA_DIR || '/projects';
const PROJECT_NAME = process.env.PROJECT_NAME     || 'default';
const SURFACE      = process.env.SURFACE          || 'unknown';

const dbPath = path.join(PROJECT_DATA, PROJECT_NAME, 'memory.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    project  TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'context',
    content  TEXT NOT NULL,
    tags     TEXT DEFAULT '[]',
    source   TEXT,
    created  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_project ON memory(project);
  CREATE INDEX IF NOT EXISTS idx_category ON memory(category);
`);

const content  = process.argv[2];
const category = process.argv[3] || 'context';
const tags     = process.argv[4] ? JSON.stringify(process.argv[4].split(',')) : '[]';

if (content) {
  db.prepare(
    'INSERT INTO memory (project, category, content, tags, source) VALUES (?, ?, ?, ?, ?)'
  ).run(PROJECT_NAME, category, content, tags, SURFACE);
  console.log('✅ Memorized');
}
db.close();
```

## Procedure /remember

```javascript
// memory-search.js
const Database = require('better-sqlite3');
const path     = require('path');

const PROJECT_DATA = process.env.PROJECT_DATA_DIR || '/projects';
const PROJECT_NAME = process.env.PROJECT_NAME     || 'default';
const query        = process.argv[2] || '';

const dbPath = path.join(PROJECT_DATA, PROJECT_NAME, 'memory.db');
if (!require('fs').existsSync(dbPath)) {
  console.log('No memory for this project yet.');
  process.exit(0);
}

const db      = new Database(dbPath, { readonly: true });
const results = db.prepare(`
  SELECT category, content, source, created
  FROM memory
  WHERE project = ? AND content LIKE ?
  ORDER BY created DESC
  LIMIT 10
`).all(PROJECT_NAME, `%${query}%`);

if (!results.length) {
  console.log(`No results for "${query}"`);
} else {
  console.log(`=== Project memory: "${query}" ===\n`);
  for (const r of results) {
    console.log(`[${r.category}] ${r.content}`);
    console.log(`  Source: ${r.source} — ${r.created}\n`);
  }
}
db.close();
```

## Automatic feeding

At the end of each session, the skill automatically memorizes:

```bash
# Decisions made (extracted from the handoff)
node /opt/skills/semantic-memory/memory-write.js \
  "Decision: $DECISION" "decision" "$TAGS"

# Discovered conventions
node /opt/skills/semantic-memory/memory-write.js \
  "Convention: $CONVENTION" "convention"

# Resolved bugs
node /opt/skills/semantic-memory/memory-write.js \
  "Bug resolved: $BUG_DESC — Fix: $FIX_DESC" "fix" "bug"
```

## Categories

- `decision` — architectural choices, technical decisions
- `convention` — code conventions, naming, structure
- `context` — general project information
- `bug` — known bugs
- `fix` — applied fixes
- `rule` — important business rules
