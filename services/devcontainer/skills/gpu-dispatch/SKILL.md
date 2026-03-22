---
name: gpu-dispatch
description: "Launches independent subtasks in parallel via isolated OpenClaw sub-agents. Use this skill when the user asks to analyze, read, or search across multiple files/sources simultaneously — e.g.: 'analyze these 3 modules', 'search in these files', 'document each file in this directory'. Each subtask runs in a background sub-agent with its own ephemeral write directory, read-only workspace access, and mcp-docs access for search. Do not use if the message contains 'sequentially', 'in order', 'first then', 'step by step'."
metadata: {"openclaw":{"emoji":"⚡","requires":{"bins":["node","curl"],"env":["SCHEDULER_URL"]}}}
user-invocable: false
---

# gpu-dispatch — Fan-out isolated sub-agents

## When to use

Detect parallelizable requests:
- Explicit list of files or modules to process
- Keywords: "each", "all the", "for each", "each file", "every file"
- Patterns: "analyze X and Y and Z", "document these files", "refactor these modules"

Do not parallelize if the message contains: "sequentially", "in order", "first then",
"step by step", "one by one".

## Procedure

### 1. Identify the subtasks

Break down the request into N independent tasks. Each task must be self-contained — it does not
depend on the result of the others. If the tasks are sequential or dependent, respond normally
without fan-out.

### 2. Check GPU availability

```bash
curl -sf "${SCHEDULER_URL}/health" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); process.stdout.write(j.mode + ' vram=' + (j.totalFree||'?') + 'GB\n')" 2>/dev/null || echo "scheduler unavailable"
```

If the scheduler is unavailable, process the tasks sequentially by responding normally.

### 3. Prepare the shared ephemeral directory

```bash
DISPATCH_ID="dispatch-$(date +%s)"
SHARED_DIR="/tmp/${DISPATCH_ID}"
mkdir -p "${SHARED_DIR}/results"
echo "Ephemeral directory: ${SHARED_DIR}"
```

### 4. Launch sub-agents in background

For each subtask, launch an OpenClaw sub-agent with:
- Its own ephemeral write directory: `/tmp/${DISPATCH_ID}/task-N/`
- Read-only access to the current workspace
- mcp-docs access for search
- Instruction to save its result in `/tmp/${DISPATCH_ID}/results/task-N.md`
- Completion notification via `openclaw system event`

```bash
# Create the isolated directory for subtask N
mkdir -p "/tmp/${DISPATCH_ID}/task-N"

# Launch the sub-agent
bash pty:false background:true timeout:120 command:"node /opt/stream-proxy/run-subagent.js \
  --task-id task-N \
  --dispatch-id ${DISPATCH_ID} \
  --workspace-read-only ${WORKSPACE_DIR} \
  --ephemeral-dir /tmp/${DISPATCH_ID}/task-N \
  --result-file /tmp/${DISPATCH_ID}/results/task-N.md \
  --prompt 'ISOLATED TASK — read-only workspace access, write only to /tmp/${DISPATCH_ID}/task-N/\n\nTask: [description of subtask N]\n\nWhen you are done, write your complete result to /tmp/${DISPATCH_ID}/results/task-N.md'"
```

**Security rules transmitted to each sub-agent:**
- Read: all files in the current workspace in read-only mode
- Write: ONLY in `/tmp/${DISPATCH_ID}/task-N/` — refuse any write elsewhere
- Execution: allowed only if explicitly necessary to read/analyze (e.g.: `cat`, `grep`,
  `find`, `git log`, `git diff` — never `rm`, `mv`, `git commit`, `git push`, nor modification
  of files outside the ephemeral directory)
- Network: mcp-docs access only (searxng, devdocs, browserless via proxy)

### 5. Wait for results (fan-in)

Wait for all sub-agents to write their result file:

```bash
# Fan-in script — waits for all result files with timeout
node /opt/stream-proxy/fanin-wait.js \
  --results-dir "/tmp/${DISPATCH_ID}/results" \
  --expected-count N \
  --timeout 120
```

### 6. Aggregate and respond

Once all results are available, read each file and compose the final response:

```bash
for f in /tmp/${DISPATCH_ID}/results/*.md; do
  echo "=== $(basename $f .md) ==="
  cat "$f"
  echo ""
done
```

Present the aggregated results in a single structured block. If a subtask failed
(file absent or containing an error), report it clearly without blocking the others.

### 7. Cleanup

```bash
rm -rf "/tmp/${DISPATCH_ID}"
```

## Limits

- Maximum 6 subtasks in parallel (GPU slot limit)
- Timeout per subtask: 120 seconds
- If a subtask exceeds the timeout, its result is marked "⏱ Timeout" in the aggregation
- Sub-agents CANNOT communicate with each other during execution
- Sub-agents CANNOT modify the current workspace or files open in VSCode

## Concrete example

Request: "Analyze the cyclomatic complexity of src/api.js, src/utils.js and src/auth.js"

-> 3 independent subtasks:
  - task-1: Analyze src/api.js (read + static analysis)
  - task-2: Analyze src/utils.js (read + static analysis)
  - task-3: Analyze src/auth.js (read + static analysis)

-> Fan-out: 3 sub-agents launched in background
-> Fan-in: aggregation when all 3 results are available
-> Response: comparative table of the 3 files
