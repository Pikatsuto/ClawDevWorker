---
name: staged-diff
description: "Manages modifications in staged mode: the agent writes to an ephemeral directory, proposes the diff, waits for /accept or /reject before committing. Use this skill for ALL file modifications in interactive sessions (chat and VSCode). In headless worker mode, staged-diff is disabled — commits are direct."
metadata: {"openclaw":{"emoji":"📋","requires":{"bins":["git","diff"]}}}
user-invocable: true
---

# staged-diff — Review before commit

## Principle

In an interactive session (chat or VSCode), the agent **never commits directly**.
It writes changes to `${STAGED_DIR}`, displays the diff, and waits for your validation.

## Work cycle

### 1. The agent writes to the staged directory

```bash
STAGED_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}/staged"
mkdir -p "$STAGED_DIR"
# The agent copies modified files here
# e.g.: $STAGED_DIR/src/auth/login.ts
```

### 2. Display the diff

```bash
# Full diff
diff -r --unified=3 "$WORKSPACE" "$STAGED_DIR" \
  --exclude='.git' --exclude='node_modules' \
  2>/dev/null | head -c 20000 || true
```

Or file by file:
```bash
diff --unified=3 "$WORKSPACE/$FILE" "$STAGED_DIR/$FILE" 2>/dev/null || true
```

### 3. Available commands

| Command | Action |
|---------|--------|
| `/diff` | Display the full diff of all staged files |
| `/diff src/auth/login.ts` | Diff of a specific file |
| `/accept` | Accept and commit all staged changes |
| `/accept src/auth/login.ts` | Accept and commit a single file |
| `/reject` | Reject all changes, empty staged |
| `/reject src/auth/login.ts` | Reject a specific file |
| `/staged` | List files pending review |

### 4. /accept — atomic commit

```bash
FILE="$1"  # empty = all files

if [ -z "$FILE" ]; then
  # All staged files
  for f in $(find "$STAGED_DIR" -type f | sed "s|$STAGED_DIR/||"); do
    cp "$STAGED_DIR/$f" "$WORKSPACE/$f"
    git -C "$WORKSPACE" add "$f"
  done
  # Commit with conventional message
  git -C "$WORKSPACE" commit -m "${COMMIT_TYPE:-feat}: ${COMMIT_MSG:-accepted changes}"
  rm -rf "$STAGED_DIR"/*
  echo "✅ All changes committed"
else
  # Specific file
  cp "$STAGED_DIR/$FILE" "$WORKSPACE/$FILE"
  git -C "$WORKSPACE" add "$FILE"
  git -C "$WORKSPACE" commit -m "${COMMIT_TYPE:-feat}($FILE): ${COMMIT_MSG:-accepted change}"
  rm -f "$STAGED_DIR/$FILE"
  echo "✅ $FILE committed"
fi
```

### 5. /reject

```bash
FILE="$1"
if [ -z "$FILE" ]; then
  rm -rf "$STAGED_DIR"/*
  echo "🗑️ All changes rejected"
else
  rm -f "$STAGED_DIR/$FILE"
  echo "🗑️ $FILE rejected"
fi
```

## Environment variables for commits

Before proposing a diff, the agent must define:
```bash
export COMMIT_TYPE="feat"   # feat | fix | refactor | test | docs | chore
export COMMIT_MSG="short description of the change"
```

## Disabled in headless mode

If `STAGED_MODE=false` (Forgejo workers), commits are direct.
The skill checks:
```bash
if [ "${STAGED_MODE:-true}" = "false" ]; then
  echo "Headless mode — direct commit"
  # immediate commit without staging
fi
```
