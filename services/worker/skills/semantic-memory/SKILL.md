---
name: semantic-memory
description: "Mémoire sémantique partagée par projet entre tous les agents et environnements. Stocke les décisions, conventions, et contexte dans un SQLite searchable. Utilise /remember pour retrouver des décisions passées, /learn pour en mémoriser de nouvelles."
metadata: {"openclaw":{"emoji":"🧠","requires":{"bins":["node","sqlite3"]}}}
user-invocable: true
---

# semantic-memory — Mémoire Projet Partagée

## Principe

Tous les agents (chat, VSCode, worker) d'un même projet partagent la même mémoire SQLite.
Elle est persistée dans `/projects/<nom>/memory.db` sur le volume partagé.

## Commandes

| Commande | Action |
|----------|--------|
| `/remember <query>` | Recherche dans la mémoire du projet |
| `/learn <fait>` | Mémorise un fait ou une décision |
| `/memory list` | Liste les entrées récentes |
| `/memory project` | Résumé de tout le contexte du projet |

## Structure de la mémoire

```sql
CREATE TABLE memory (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  project   TEXT NOT NULL,
  category  TEXT NOT NULL,  -- decision | convention | context | bug | fix
  content   TEXT NOT NULL,
  tags      TEXT,           -- JSON array de tags
  source    TEXT,           -- qui l'a écrit : chat | vscode | worker-qa | etc.
  created   TEXT NOT NULL,
  embedding TEXT            -- vecteur simplifié pour recherche sémantique
);
```

## Procédure /learn

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
  console.log('✅ Mémorisé');
}
db.close();
```

## Procédure /remember

```javascript
// memory-search.js
const Database = require('better-sqlite3');
const path     = require('path');

const PROJECT_DATA = process.env.PROJECT_DATA_DIR || '/projects';
const PROJECT_NAME = process.env.PROJECT_NAME     || 'default';
const query        = process.argv[2] || '';

const dbPath = path.join(PROJECT_DATA, PROJECT_NAME, 'memory.db');
if (!require('fs').existsSync(dbPath)) {
  console.log('Aucune mémoire pour ce projet encore.');
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
  console.log(`Aucun résultat pour "${query}"`);
} else {
  console.log(`=== Mémoire projet : "${query}" ===\n`);
  for (const r of results) {
    console.log(`[${r.category}] ${r.content}`);
    console.log(`  Source: ${r.source} — ${r.created}\n`);
  }
}
db.close();
```

## Alimentation automatique

À chaque fin de session, le skill mémorise automatiquement :

```bash
# Décisions prises (extraites du handoff)
node /opt/skills/semantic-memory/memory-write.js \
  "Décision: $DECISION" "decision" "$TAGS"

# Conventions découvertes
node /opt/skills/semantic-memory/memory-write.js \
  "Convention: $CONVENTION" "convention"

# Bugs résolus
node /opt/skills/semantic-memory/memory-write.js \
  "Bug résolu: $BUG_DESC — Fix: $FIX_DESC" "fix" "bug"
```

## Catégories

- `decision` — choix architecturaux, décisions techniques
- `convention` — conventions de code, naming, structure
- `context` — informations générales sur le projet
- `bug` — bugs connus
- `fix` — corrections apportées
- `rule` — règles métier importantes
