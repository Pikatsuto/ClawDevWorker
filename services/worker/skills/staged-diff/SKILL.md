---
name: staged-diff
description: "Gère les modifications en mode staged : l'agent écrit dans un dossier éphémère, propose le diff, attend /accept ou /reject avant de committer. Utilise ce skill pour TOUTES les modifications de fichiers en session interactive (chat et VSCode). En mode worker headless, le staged-diff est désactivé — les commits sont directs."
metadata: {"openclaw":{"emoji":"📋","requires":{"bins":["git","diff"]}}}
user-invocable: true
---

# staged-diff — Review avant commit

## Principe

En session interactive (chat ou VSCode), l'agent **ne commit jamais directement**.
Il écrit les changements dans `${STAGED_DIR}`, affiche le diff, et attend ta validation.

## Cycle de travail

### 1. L'agent écrit dans le dossier staged

```bash
STAGED_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}/staged"
mkdir -p "$STAGED_DIR"
# L'agent copie les fichiers modifiés ici
# ex: $STAGED_DIR/src/auth/login.ts
```

### 2. Afficher le diff

```bash
# Diff complet
diff -r --unified=3 "$WORKSPACE" "$STAGED_DIR" \
  --exclude='.git' --exclude='node_modules' \
  2>/dev/null | head -c 20000 || true
```

Ou fichier par fichier :
```bash
diff --unified=3 "$WORKSPACE/$FILE" "$STAGED_DIR/$FILE" 2>/dev/null || true
```

### 3. Commandes disponibles

| Commande | Action |
|----------|--------|
| `/diff` | Affiche le diff complet de tous les fichiers staged |
| `/diff src/auth/login.ts` | Diff d'un fichier spécifique |
| `/accept` | Accepte et committe tous les changements staged |
| `/accept src/auth/login.ts` | Accepte et committe un fichier |
| `/reject` | Rejette tous les changements, vide staged |
| `/reject src/auth/login.ts` | Rejette un fichier spécifique |
| `/staged` | Liste les fichiers en attente |

### 4. /accept — commit atomique

```bash
FILE="$1"  # vide = tous les fichiers

if [ -z "$FILE" ]; then
  # Tous les fichiers staged
  for f in $(find "$STAGED_DIR" -type f | sed "s|$STAGED_DIR/||"); do
    cp "$STAGED_DIR/$f" "$WORKSPACE/$f"
    git -C "$WORKSPACE" add "$f"
  done
  # Commit avec message conventionnel
  git -C "$WORKSPACE" commit -m "${COMMIT_TYPE:-feat}: ${COMMIT_MSG:-changements acceptés}"
  rm -rf "$STAGED_DIR"/*
  echo "✅ Tous les changements commités"
else
  # Fichier spécifique
  cp "$STAGED_DIR/$FILE" "$WORKSPACE/$FILE"
  git -C "$WORKSPACE" add "$FILE"
  git -C "$WORKSPACE" commit -m "${COMMIT_TYPE:-feat}($FILE): ${COMMIT_MSG:-changement accepté}"
  rm -f "$STAGED_DIR/$FILE"
  echo "✅ $FILE commité"
fi
```

### 5. /reject

```bash
FILE="$1"
if [ -z "$FILE" ]; then
  rm -rf "$STAGED_DIR"/*
  echo "🗑️ Tous les changements rejetés"
else
  rm -f "$STAGED_DIR/$FILE"
  echo "🗑️ $FILE rejeté"
fi
```

## Variables d'env pour les commits

Avant de proposer un diff, l'agent doit définir :
```bash
export COMMIT_TYPE="feat"   # feat | fix | refactor | test | docs | chore
export COMMIT_MSG="description courte du changement"
```

## Désactivé en mode headless

Si `STAGED_MODE=false` (workers Forgejo), les commits sont directs.
Le skill vérifie :
```bash
if [ "${STAGED_MODE:-true}" = "false" ]; then
  echo "Mode headless — commit direct"
  # commit immédiat sans staging
fi
```
