---
name: session-handoff
description: "Génère un document de handoff portable pour reprendre une session dans n'importe quel environnement. Utilise /handoff pour sauvegarder l'état courant et /resume pour reprendre. Les handoffs sont partagés entre chat, VSCode et worker via le volume project_data."
metadata: {"openclaw":{"emoji":"🤝","requires":{"bins":["node","date"]}}}
user-invocable: true
---

# session-handoff — Portabilité inter-environnements

## Commandes

| Commande | Action |
|----------|--------|
| `/handoff` | Génère le handoff de la session courante |
| `/handoff "contexte"` | Handoff avec note de contexte |
| `/resume` | Liste les handoffs disponibles |
| `/resume latest` | Reprend le handoff le plus récent |
| `/resume <id>` | Reprend un handoff spécifique |

## Procédure /handoff

### 1. Collecter l'état de la session

L'agent résume en quelques lignes :
- Tâche en cours et ce qui a été accompli
- Décisions prises et pourquoi
- Fichiers modifiés (et leur état : staged / commité / en cours)
- Prochaines étapes
- Contexte important à ne pas oublier

### 2. Générer le fichier YAML

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

  // À remplir par l'agent
  task: {
    description: '${TASK_DESCRIPTION}',
    progress:    '${TASK_PROGRESS}',
    status:      '${TASK_STATUS}',  // in-progress | blocked | ready-for-next
  },

  decisions: [
    // { what: '...', why: '...', when: '...' }
  ],

  files: {
    modified: [],  // fichiers modifiés non commités
    staged:   [],  // fichiers dans le dossier staged
    committed: [], // fichiers commités dans cette session
  },

  git: {
    branch:      '${GIT_BRANCH}',
    lastCommit:  '${LAST_COMMIT}',
  },

  next_steps: [
    // '...'
  ],

  memory_snapshot: '${MEMORY_SUMMARY}',  // résumé des décisions importantes
};

fs.writeFileSync(filepath, require('./yaml-serialize')(handoff));
console.log(`Handoff sauvegardé : ${filepath}`);
console.log(`ID : ${handoff.id}`);
```

### 3. Collecter l'état git automatiquement

```bash
GIT_BRANCH=$(git -C "$WORKSPACE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
LAST_COMMIT=$(git -C "$WORKSPACE" log -1 --oneline 2>/dev/null || echo "")
MODIFIED=$(git -C "$WORKSPACE" status --short 2>/dev/null | head -20)
export GIT_BRANCH LAST_COMMIT MODIFIED
```

## Procédure /resume

### 1. Lister les handoffs disponibles

```bash
PROJECT_DATA="${PROJECT_DATA_DIR:-/projects}"
PROJECT_NAME="${PROJECT_NAME:-default}"
SESSIONS_DIR="$PROJECT_DATA/$PROJECT_NAME/sessions"

echo "=== Handoffs disponibles ==="
ls -t "$SESSIONS_DIR"/*.yaml 2>/dev/null | head -10 | while read f; do
  ID=$(basename "$f" .yaml)
  SURFACE=$(grep 'surface:' "$f" | head -1 | awk '{print $2}')
  CONTEXT=$(grep 'context:' "$f" | head -1 | cut -d: -f2-)
  echo "  $ID ($SURFACE) $CONTEXT"
done
```

### 2. Charger un handoff

```bash
ID="${1:-latest}"

if [ "$ID" = "latest" ]; then
  FILE=$(ls -t "$SESSIONS_DIR"/*.yaml 2>/dev/null | head -1)
else
  FILE="$SESSIONS_DIR/$ID.yaml"
fi

if [ ! -f "$FILE" ]; then
  echo "Handoff introuvable : $ID"
  exit 1
fi

echo "=== Reprise de la session ==="
cat "$FILE"
```

Après avoir lu le fichier, l'agent reprend exactement là où la session précédente s'est arrêtée :
- Il recharge le contexte git (branche, derniers commits)
- Il reprend les fichiers staged si présents
- Il continue les next_steps dans l'ordre

## Partage entre environnements

Le volume `project_data` est monté sur tous les services :
- `/projects/<nom>/sessions/` — handoffs
- `/projects/<nom>/memory.db` — mémoire sémantique
- `/projects/<nom>/rules.yaml` — règles pipeline

Ainsi un handoff créé dans VSCode est immédiatement disponible dans le chat et vice-versa.
