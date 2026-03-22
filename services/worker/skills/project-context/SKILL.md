---
name: project-context
description: "Charge le contexte d'un projet pour travailler dessus dans n'importe quel environnement. /project select charge la mémoire et les conventions. /project status montre les issues et PRs en cours. /project code charge le code en lecture seule (explicite). Partage le contexte entre chat, VSCode et worker."
metadata: {"openclaw":{"emoji":"📁","requires":{"bins":["node","git","curl"],"env":["PROJECT_DATA_DIR"]}}}
user-invocable: true
---

# project-context — Contexte Projet Multi-environnements

## Commandes

| Commande | Action |
|----------|--------|
| `/project list` | Liste les projets configurés |
| `/project select <nom>` | Charge le contexte du projet |
| `/project status` | Issues et PRs en cours (API git) |
| `/project code` | Charge le code en lecture seule (explicite) |
| `/project memory` | Affiche la mémoire du projet |
| `/project rules` | Affiche les règles pipeline du projet |

## Procédure /project select

### 1. Charger les fichiers .coderclaw/ du projet

```bash
PROJECT_DATA="${PROJECT_DATA_DIR:-/projects}"
PROJECT_NAME="$1"
PROJECT_DIR="$PROJECT_DATA/$PROJECT_NAME"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Projet '$PROJECT_NAME' introuvable. Projets disponibles :"
  ls "$PROJECT_DATA" 2>/dev/null
  exit 1
fi

export PROJECT_NAME
echo "=== Projet : $PROJECT_NAME ==="

# Charger les fichiers de contexte dans l'ordre
for f in context.yaml architecture.md rules.yaml design.md; do
  FILE="$PROJECT_DIR/$f"
  [ -f "$FILE" ] && echo "--- $f ---" && cat "$FILE" && echo ""
done
```

### 2. Afficher la mémoire récente

```bash
node /opt/skills/semantic-memory/memory-search.js "" 2>/dev/null | head -30
```

### 3. Afficher le dernier handoff

```bash
LAST_HANDOFF=$(ls -t "$PROJECT_DIR/sessions"/*.yaml 2>/dev/null | head -1)
if [ -n "$LAST_HANDOFF" ]; then
  echo "=== Dernier handoff ==="
  cat "$LAST_HANDOFF"
fi
```

## Procédure /project status

Récupère les issues et PRs ouvertes via l'API git provider :

```bash
# Variables injectées par l'environnement
GIT_REPO="${PROJECT_REPO:-}"  # owner/repo
GIT_URL="${FORGEJO_URL:-https://api.github.com}"
GIT_TOKEN="${FORGEJO_TOKEN:-$GITHUB_TOKEN}"

if [ -z "$GIT_REPO" ]; then
  echo "PROJECT_REPO non configuré pour ce projet"
  exit 1
fi

# Issues ouvertes
echo "=== Issues ouvertes ==="
curl -sf -H "Authorization: token $GIT_TOKEN" \
  "$GIT_URL/api/v1/repos/$GIT_REPO/issues?type=issues&state=open&limit=10" \
  2>/dev/null | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (!Array.isArray(d)) { console.log('Erreur API'); process.exit(1); }
    d.slice(0,10).forEach(i => {
      const labels = (i.labels||[]).map(l=>l.name).join(', ');
      console.log(\`#\${i.number} [\${labels||'no label'}] \${i.title}\`);
    });
  " 2>/dev/null || echo "(API indisponible)"

# PRs ouvertes
echo ""
echo "=== Pull Requests ouvertes ==="
curl -sf -H "Authorization: token $GIT_TOKEN" \
  "$GIT_URL/api/v1/repos/$GIT_REPO/pulls?state=open&limit=10" \
  2>/dev/null | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (!Array.isArray(d)) { console.log('Erreur API'); process.exit(1); }
    d.slice(0,10).forEach(p => {
      console.log(\`PR #\${p.number} [\${p.head?.ref}→\${p.base?.ref}] \${p.title}\`);
    });
  " 2>/dev/null || echo "(API indisponible)"
```

## Procédure /project code (explicite)

Charge le code en lecture seule — uniquement sur demande explicite :

```bash
CLONE_DIR="/tmp/project-readonly-$PROJECT_NAME"

if [ ! -d "$CLONE_DIR" ]; then
  # Clone en lecture seule (shallow, read-only token si dispo)
  git clone --depth=10 \
    "${GIT_READ_URL:-$GIT_URL/$GIT_REPO.git}" \
    "$CLONE_DIR" 2>/dev/null \
    || { echo "Clone échoué — vérifier GIT_READ_URL"; exit 1; }
  echo "✅ Code cloné dans $CLONE_DIR (lecture seule)"
else
  git -C "$CLONE_DIR" pull --quiet
  echo "✅ Code mis à jour"
fi

echo "Fichiers disponibles en lecture :"
find "$CLONE_DIR" -type f \
  ! -path "*/.git/*" ! -path "*/node_modules/*" \
  | sed "s|$CLONE_DIR/||" | head -30
echo "(lecture seule — aucune modification possible sur ce clone)"
```

## Initialiser un nouveau projet

```bash
/project init <nom> <owner/repo>
```

Crée la structure dans `PROJECT_DATA` :

```
/projects/<nom>/
├── context.yaml      # métadonnées du projet
├── architecture.md   # architecture (optionnel)
├── rules.yaml        # pipeline RBAC
├── design.md         # charte graphique (optionnel)
├── sessions/         # handoffs
└── memory.db         # mémoire sémantique
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
    triggers: [seo, landing, vitrine, copy]
  design:
    triggers: [ui, ux, charte, branding]
YAML

echo "✅ Projet '$PROJECT_NAME' initialisé"
```
