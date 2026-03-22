---
name: codebase-analyze
description: "Analyse la structure du codebase avant toute modification : parse les fichiers TypeScript/JavaScript/Python, construit un dependency graph, calcule l'impact radius d'un changement. Utilise ce skill AVANT de commencer à coder sur une issue ou une tâche. Stocke le résultat dans .coderclaw/memory/codebase-index.json."
metadata: {"openclaw":{"emoji":"🔍","requires":{"bins":["node","find","grep"]}}}
user-invocable: true
---

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
