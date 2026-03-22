---
name: loop-detect
description: "Detects and interrupts infinite loops: same error repeated, same file modified without progress, same command failing in a loop. Use this skill AUTOMATICALLY when you feel you are going in circles, redoing the same thing without making progress, or have failed more than 2 times on the same task. In VSCode: ask the human for help. In headless worker: signal FAIL with detailed summary."
metadata: {"openclaw":{"emoji":"🔁","always":true}}
user-invocable: false
---

# loop-detect — Automatic infinite loop detection

## Warning signals — you must stop if:

1. **You modify the same file more than 3 times** to fix the same error
2. **The same command fails more than 2 times** with the same type of error
3. **Tests still fail** after 2 fix → test → fix cycles
4. **You re-read the same instructions** looking for something that is not there
5. **You generate code that reproduces an error** you had already fixed
6. **The diff of your changes is empty** after having "fixed"

## Automatic detection procedure

Before each new fix attempt, check:

```bash
# Recent git history — are we going in circles?
RECENT=$(git -C "$WORKSPACE" log --oneline -10 2>/dev/null || echo "")
echo "$RECENT"

# Files modified multiple times in the session
CHANGED_FILES=$(git -C "$WORKSPACE" diff --name-only HEAD~5 HEAD 2>/dev/null | sort | uniq -d)
if [ -n "$CHANGED_FILES" ]; then
  TOUCH_COUNT=$(echo "$CHANGED_FILES" | wc -l)
  echo "⚠️ Files modified multiple times: $CHANGED_FILES"
fi

# Same error message in recent commits?
LAST_MSGS=$(git -C "$WORKSPACE" log --format="%s" -5 2>/dev/null)
echo "Recent commits: $LAST_MSGS"
```

## Action depending on the surface

### In VSCode (interactive session)

When a loop is detected, **stop immediately** and ask for help:

```
🔁 **Loop detected — I need help**

I have tried N times to fix [description of the problem] without success.

**What I have tried:**
1. [attempt 1]
2. [attempt 2]
3. [attempt 3]

**Where I am stuck:**
[precise description of the persisting problem]

**Files involved:**
- [file 1]
- [file 2]

Can you point me in the right direction or look at the code with me?
```

Never continue after this message without a human response.

### In headless worker (Forgejo/GitHub)

Immediately call `task_complete` with `result: "fail"` and a detailed summary:

```bash
# Summary for task_complete
LOOP_SUMMARY="🔁 Infinite loop detected after N attempts.

**Problem:** [description]
**Latest attempts:**
$(git -C "$WORKSPACE" log --oneline -5 2>/dev/null)

**Persistent error:**
[exact error message]

**Files involved:**
$(git -C "$WORKSPACE" diff --name-only HEAD~3 HEAD 2>/dev/null)"

# Signal via task_complete
curl -sf -X POST "http://localhost:19000/task-complete" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg repo    "$REPO" \
    --argjson id  "$ISSUE_ID" \
    --arg role    "$ROLE" \
    --arg result  "fail" \
    --arg summary "$LOOP_SUMMARY" \
    '{repo:$repo, issueId:$id, role:$role, result:$result, summary:$summary}'
  )"
```

## Attempt counter (local state)

```bash
LOOP_STATE_FILE="/tmp/loop-detect-${REPO//\//_}-${ISSUE_ID:-0}.json"

function increment_attempt() {
  local key="$1"
  local count=0
  if [ -f "$LOOP_STATE_FILE" ]; then
    count=$(jq -r ".\"$key\" // 0" "$LOOP_STATE_FILE" 2>/dev/null || echo 0)
  fi
  count=$((count + 1))
  echo "{\"$key\": $count}" | jq -s '.[0] * (if test("^\\{") then . else {} end)' > "$LOOP_STATE_FILE" 2>/dev/null || true
  echo $count
}

function get_attempt_count() {
  local key="$1"
  [ -f "$LOOP_STATE_FILE" ] && jq -r ".\"$key\" // 0" "$LOOP_STATE_FILE" 2>/dev/null || echo 0
}

function reset_attempts() {
  rm -f "$LOOP_STATE_FILE"
}

# Usage example:
ATTEMPTS=$(increment_attempt "fix_auth_middleware")
if [ "$ATTEMPTS" -ge 3 ]; then
  echo "⚠️ 3 attempts on fix_auth_middleware — loop detection active"
fi
```

## Absolute rule

**You NEVER attempt a 4th fix of the same problem.**
After 3 failures: stop + ask for help (VSCode) or FAIL + summary (worker).
