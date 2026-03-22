---
name: codebase-analyze
description: "Analyse la structure du codebase avec un index AST incrémental (git-diff based). Ne scanne que les fichiers modifiés depuis le dernier index — jamais le projet entier à chaque fois. Utilise ce skill AVANT de commencer à coder sur une issue. Commandes : /analyze (incrémental), /analyze --full (premier run), /search <query>, /impact <fichier>, /symbols <nom>."
metadata: {"openclaw":{"emoji":"🔍","requires":{"bins":["node","git"]}}}
user-invocable: true
---

# codebase-analyze — Index AST incrémental

## Principe : git-diff based, jamais full-scan sauf au premier run

L'index est stocké dans `$PROJECT_DATA_DIR/$PROJECT_NAME/.coderclaw/codebase-index.json` et **partagé entre tous les agents du même projet** (chat, VSCode, workers) via le volume `project_data`.

```
Premier run sur un repo :
  → scan complet → index complet stocké

Runs suivants :
  → git diff --name-only $LAST_COMMIT HEAD
  → re-parse uniquement les fichiers modifiés
  → merge delta dans l'index existant
  → jamais de scan complet sauf --full
```

## Commandes

| Commande | Action |
|----------|--------|
| `/analyze` | Mise à jour incrémentale (git diff) |
| `/analyze --full` | Scan complet forcé |
| `/search <query>` | Recherche sémantique dans l'index |
| `/impact <fichier>` | Impact radius d'un fichier |
| `/symbols <nom>` | Où un symbole est défini / utilisé |

## Utilisation dans un script

```bash
INDEX_SCRIPT="/opt/skills/codebase-analyze/incremental-index.js"

# Mise à jour incrémentale (défaut — à lancer en début de chaque tâche)
node "$INDEX_SCRIPT"

# Premier run ou force
node "$INDEX_SCRIPT" --full

# Recherche
node "$INDEX_SCRIPT" --search "loginUser"

# Impact radius avant modification
node "$INDEX_SCRIPT" --impact "src/auth/login.ts"

# Symbole
node "$INDEX_SCRIPT" --symbols "AuthError"
```

## Workflow automatique dans run-worker.sh

```bash
# 1. Mise à jour incrémentale de l'index au démarrage du worker
node /opt/skills/codebase-analyze/incremental-index.js

# 2. Avant de toucher un fichier → calcul impact radius
node /opt/skills/codebase-analyze/incremental-index.js \
  --impact "src/auth/login.ts"

# 3. Après les commits → mise à jour de l'index
node /opt/skills/codebase-analyze/incremental-index.js
```

## Ce que l'index contient

Pour chaque fichier :
- `imports` — modules importés
- `exports` — symboles exportés
- `symbols` — fonctions et classes définies
- `lines` — nombre de lignes
- `ext` — extension
- `mtime` — timestamp de modification

## Limites

- Analyse syntaxique légère (regex), pas un vrai parser AST
- Max `INDEX_MAX_FILES` fichiers (défaut 500) pour rester dans le contexte
- Les dépendances circulaires ne sont pas détectées
- Pas d'analyse de flux de données inter-fichiers


# codebase-analyze — Analyse AST et Impact

## Quand l'utiliser

- **Automatiquement** au début de chaque tâche worker Forgejo/GitHub
- **Sur demande** : `/analyze` ou `/analyze src/auth/`
- **Avant une refacto** pour connaître l'impact radius

## Procédure

### 1. Lister les fichiers du projet

```bash
WORKSPACE="${WORKSPACE:-$(pwd)}"
INDEX_FILE="${OPENCLAW_DIR:-$HOME/.openclaw}/.coderclaw/memory/codebase-index.json"
mkdir -p "$(dirname "$INDEX_FILE")"

# Fichiers de code (exclut node_modules, .git, dist, build)
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
| head -200)  # limite 200 fichiers pour rester dans le contexte

echo "Fichiers analysés : $(echo "$FILES" | wc -l)"
```

### 2. Analyse des imports/exports (Node.js)

```javascript
// analyze.js — script d'analyse AST léger
const fs   = require('fs');
const path = require('path');

const WORKSPACE = process.env.WORKSPACE || process.cwd();
const files     = process.argv.slice(2);
const index     = {};

for (const file of files) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(WORKSPACE, file);

    // Extraire imports
    const imports = [];
    const importRe = /(?:import|require)\s*(?:\(?\s*['"])([^'"]+)['"]\s*\)?/g;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      imports.push(m[1]);
    }

    // Extraire exports
    const exports = [];
    const exportRe = /export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum)\s+(\w+)/g;
    while ((m = exportRe.exec(content)) !== null) {
      exports.push(m[1]);
    }

    // Extraire fonctions/classes principales
    const symbols = [];
    const symRe = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)/g;
    while ((m = symRe.exec(content)) !== null) {
      symbols.push(m[1]);
    }

    // Compter les lignes
    const lines = content.split('\n').length;

    index[relPath] = { imports, exports, symbols, lines };
  } catch {}
}

process.stdout.write(JSON.stringify(index, null, 2));
```

```bash
# Lancer l'analyse
node /opt/skills/codebase-analyze/analyze.js $FILES > "$INDEX_FILE"
echo "Index écrit : $INDEX_FILE"
```

### 3. Calcul de l'impact radius

Pour un fichier cible (ex: `src/auth/login.ts`) :

```javascript
// impact.js — calcule quels fichiers importent le fichier cible
const index  = JSON.parse(require('fs').readFileSync(process.env.INDEX_FILE));
const target = process.argv[2]; // ex: src/auth/login.ts

const impacted = [];
for (const [file, info] of Object.entries(index)) {
  const importsTarget = info.imports.some(imp => {
    // Résolution relative simple
    return imp.includes(target.replace('.ts','').replace('.js','')) ||
           imp.endsWith(target.split('/').pop().replace('.ts',''));
  });
  if (importsTarget) impacted.push(file);
}

console.log(JSON.stringify({ target, impacted, count: impacted.length }));
```

### 4. Résumé pour l'agent

Après l'analyse, produit un résumé concis :

```
## Analyse codebase — ${WORKSPACE}

**Fichiers analysés :** N
**Impact radius de ${TARGET_FILE} :** M fichiers impactés
  - src/components/LoginForm.vue
  - src/middleware/auth.ts
  - tests/auth.test.ts

**Symboles exportés par ${TARGET_FILE} :**
  - loginUser, validateToken, AuthError

**Recommandation :** Modifier ces ${M} fichiers nécessite de vérifier...
```

### 5. Mise à jour incrémentale

L'index est mis à jour uniquement pour les fichiers modifiés :

```bash
# Fichiers modifiés depuis le dernier commit
CHANGED=$(git -C "$WORKSPACE" diff --name-only HEAD 2>/dev/null || echo "")
if [ -n "$CHANGED" ]; then
  node /opt/skills/codebase-analyze/analyze.js $CHANGED >> "$INDEX_FILE.patch"
fi
```

## Commandes

| Commande | Action |
|----------|--------|
| `/analyze` | Analyse tout le workspace |
| `/analyze src/auth/` | Analyse un dossier spécifique |
| `/impact src/auth/login.ts` | Calcule l'impact radius d'un fichier |
| `/symbols ClassName` | Cherche où un symbole est utilisé |
