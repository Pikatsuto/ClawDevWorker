---
name: agent-fanout
description: "Breaks down a complex issue into independent subtasks and launches parallel OpenClaw sub-agents. Use this skill when the issue involves multiple distinct modules, multiple files with no dependencies between them, or multiple logically separable features. Each sub-agent works on its own branch and opens its own PRs. Do not use if tasks are sequential or dependent on each other."
metadata: {"openclaw":{"emoji":"🔀","requires":{"bins":["node","curl","jq"],"env":["SCHEDULER_URL","FORGEJO_TOKEN","FORGEJO_URL","REPO","ISSUE_ID","PARENT_BRANCH","OLLAMA_BASE_URL","OLLAMA_MODEL"]}}}
user-invocable: false
---

# agent-fanout — Sub-agent fan-out in the worker

## When to decompose

**Decompose if the issue:**
- Explicitly mentions multiple distinct modules/components
- Can be split into N tasks with no required ordering between them
- Contains words like: "each", "all", "for each module", "and also"
- Involves more than 5 files in different directories

**Do NOT decompose if:**
- Tasks are sequential ("first X, then Y")
- One task depends on the result of another
- The issue is simple (< 3 files, 1 module)
- The BMAD context explicitly forbids parallelization

## Decomposability analysis (CPU)

Before decomposing, validate with the CPU model:

```bash
DECOMPOSE_CHECK=$(curl -sf -X POST "${OLLAMA_CPU_URL:-http://ollama-cpu:11434}/api/generate" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg prompt "Analyze this issue and determine if it can be decomposed into INDEPENDENT subtasks (with no dependencies between them).

Issue: \"${ISSUE_TITLE}\"
Description: \"${ISSUE_BODY_SHORT}\"

Respond ONLY in JSON:
{
  \"decomposable\": true/false,
  \"reason\": \"short explanation\",
  \"subtasks\": [
    {\"id\": \"task-1\", \"scope\": \"module or files involved\", \"type\": \"feat|fix|refactor|test\", \"description\": \"what this subtask does\"},
    ...
  ]
}
If decomposable=false, subtasks=[]." \
    '{model:"qwen3.5:0.8b", prompt:$prompt, stream:false, keep_alive:0, options:{num_gpu:0,num_predict:300,temperature:0}}'
  )" | jq -r '.response // ""' | grep -o '{.*}' | head -1)

DECOMPOSABLE=$(echo "$DECOMPOSE_CHECK" | jq -r '.decomposable // false')
SUBTASKS=$(echo "$DECOMPOSE_CHECK" | jq -r '.subtasks // []')
SUBTASK_COUNT=$(echo "$SUBTASKS" | jq 'length')
```

If `decomposable=false` or `subtask_count < 2` → handle the issue normally without fan-out.

## Fan-out procedure

### 1. Prepare sub-agent branches

```bash
DISPATCH_ID="fanout-${ISSUE_ID}-$(date +%s)"

# For each identified subtask
for task in $(echo "$SUBTASKS" | jq -c '.[]'); do
  TASK_ID=$(echo "$task" | jq -r '.id')
  TASK_TYPE=$(echo "$task" | jq -r '.type')
  TASK_SCOPE=$(echo "$task" | jq -r '.scope' | tr ' /' '--' | tr '[:upper:]' '[:lower:]' | cut -c1-20)
  TASK_DESC=$(echo "$task" | jq -r '.description')

  # Sub-agent branch: starts from PARENT_BRANCH
  SUB_BRANCH="${TASK_TYPE}/${ISSUE_ID}-${TASK_SCOPE}"

  git checkout "${PARENT_BRANCH}"
  git checkout -b "${SUB_BRANCH}" 2>/dev/null || git checkout "${SUB_BRANCH}"
  git push origin "${SUB_BRANCH}" --set-upstream 2>/dev/null || true
  git checkout "${PARENT_BRANCH}"

  echo "Sub-agent branch created: ${SUB_BRANCH}"
done
```

### 2. Request GPU slots from the scheduler

```bash
# Reserve N slots — one per subtask
SLOT_REQUEST=$(curl -sf -X POST "${SCHEDULER_URL}/chat/fanout" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --argjson count "$SUBTASK_COUNT" \
    --arg surface "agent" \
    '{subtasks: [range($count) | {messages:[], surface:"agent"}], surface: $surface}'
  )")

echo "GPU slots allocated: $(echo "$SLOT_REQUEST" | jq '.subtasks | length')"
```

### 3. Launch sub-agents in background

For each subtask, launch an isolated OpenClaw sub-agent:

```bash
RESULTS_DIR="/tmp/${DISPATCH_ID}/results"
mkdir -p "$RESULTS_DIR"

IDX=0
for task in $(echo "$SUBTASKS" | jq -c '.[]'); do
  TASK_ID=$(echo "$task"   | jq -r '.id')
  TASK_TYPE=$(echo "$task" | jq -r '.type')
  TASK_SCOPE=$(echo "$task"| jq -r '.scope' | tr ' /' '--' | tr '[:upper:]' '[:lower:]' | cut -c1-20)
  TASK_DESC=$(echo "$task" | jq -r '.description')
  SUB_BRANCH="${TASK_TYPE}/${ISSUE_ID}-${TASK_SCOPE}"

  # GPU slot for this sub-agent
  SLOT=$(echo "$SLOT_REQUEST" | jq -c ".subtasks[${IDX}]")
  SUB_MODEL=$(echo "$SLOT"   | jq -r '.model // env.OLLAMA_MODEL')
  SUB_OLLAMA=$(echo "$SLOT"  | jq -r '.ollamaUrl // env.OLLAMA_BASE_URL')
  SUB_SLOT_ID=$(echo "$SLOT" | jq -r '.slotId // ""')

  RESULT_FILE="${RESULTS_DIR}/${TASK_ID}.json"
  EPHEMERAL_DIR="/tmp/${DISPATCH_ID}/${TASK_ID}"
  mkdir -p "$EPHEMERAL_DIR"

  # Isolated workspace directory — reads from the repo, writes to ephemeral only
  # The sub-agent receives the cloned repo as a read-only workspace
  # It can only write to EPHEMERAL_DIR
  # Git push is allowed on SUB_BRANCH only

  bash pty:false background:true timeout:300 command:"
    export FORGEJO_TOKEN='${FORGEJO_TOKEN}'
    export FORGEJO_URL='${FORGEJO_URL}'
    export REPO='${REPO}'
    export ISSUE_ID='${ISSUE_ID}'
    export PARENT_BRANCH='${PARENT_BRANCH}'
    export OLLAMA_MODEL='${SUB_MODEL}'
    export OLLAMA_BASE_URL='${SUB_OLLAMA}'
    export OLLAMA_CPU_URL='${OLLAMA_CPU_URL}'
    export SCHEDULER_URL='${SCHEDULER_URL}'
    export SLOT_ID='${SUB_SLOT_ID}'
    export EPHEMERAL_DIR='${EPHEMERAL_DIR}'
    export RESULT_FILE='${RESULT_FILE}'
    export SUB_BRANCH='${SUB_BRANCH}'
    export TASK_DESC='${TASK_DESC}'
    export TASK_TYPE='${TASK_TYPE}'
    node /opt/agent-fanout/run-subagent.js
  "

  IDX=$((IDX + 1))
done
```

### 4. Wait for fan-in

```bash
node /opt/agent-fanout/fanin-wait.js \
  --results-dir "$RESULTS_DIR" \
  --expected-count "$SUBTASK_COUNT" \
  --timeout 300
```

### 5. Aggregate and open the main PR

Once all sub-agents have completed:

```bash
# Collect results
PR_LIST=""
SUMMARY=""
for f in "$RESULTS_DIR"/*.json; do
  [ -f "$f" ] || continue
  TASK_STATUS=$(jq -r '.status // "unknown"' "$f")
  TASK_PR=$(jq -r '.prNumber // ""' "$f")
  TASK_BRANCH=$(jq -r '.branch // ""' "$f")
  TASK_SUMMARY=$(jq -r '.summary // ""' "$f")

  if [ -n "$TASK_PR" ]; then
    PR_LIST="${PR_LIST}- #${TASK_PR} (${TASK_BRANCH})\n"
  fi
  SUMMARY="${SUMMARY}\n### ${TASK_BRANCH}\n${TASK_SUMMARY}\n"
done

# Main PR issue → main
curl -sf -X POST \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  -H "Content-Type: application/json" \
  "${FORGEJO_URL}/api/v1/repos/${REPO}/pulls" \
  -d "$(jq -n \
    --arg title "Issue #${ISSUE_ID}: ${ISSUE_TITLE}" \
    --arg body  "Closes #${ISSUE_ID}\n\n## Summary\n${SUMMARY}\n\n## Atomic PRs\n${PR_LIST}" \
    --arg head  "${PARENT_BRANCH}" \
    --arg base  "main" \
    '{title:$title, body:$body, head:$head, base:$base}'
  )"

# Cleanup
rm -rf "/tmp/${DISPATCH_ID}"
```

## Sub-agent security

Each sub-agent:
- Read: the entire cloned repo (read-only for existing files)
- Write: only to its `EPHEMERAL_DIR` for the scratchpad, and via `git` on `SUB_BRANCH` only
- Network: Forgejo + Ollama + mcp-docs via proxy
- CANNOT push to `main`, `develop`, or any branches other than `SUB_BRANCH`
- CANNOT merge PRs
- CANNOT modify the infrastructure config

## Limits

- Maximum 4 sub-agents in parallel (conservative VRAM limit)
- Timeout per sub-agent: 300 seconds
- If a sub-agent fails: its result is marked `{status:"failed"}`, the others continue
- If < 2 subtasks identified: do not fan-out, handle normally
