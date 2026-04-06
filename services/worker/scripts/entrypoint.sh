#!/usr/bin/env bash
###############################################################################
# run-worker.sh — Ephemeral ClawForge worker v2
#
# Launches an autonomous OpenClaw agent to solve a Forgejo issue.
# The agent iterates freely: analyze → code → atomic commits → PRs.
# Fan-out possible via the agent-fanout skill if the issue is decomposable.
#
# Required environment variables:
#   FORGEJO_TOKEN, FORGEJO_URL, REPO, ISSUE_ID, ROLE
#   OLLAMA_MODEL, OLLAMA_BASE_URL, OLLAMA_CPU_URL
#   SLOT_ID, SCHEDULER_URL
###############################################################################

set -euo pipefail

FORGEJO_TOKEN="${FORGEJO_TOKEN:?FORGEJO_TOKEN required}"
FORGEJO_URL="${FORGEJO_URL:?FORGEJO_URL required}"
REPO="${REPO:?REPO required}"
ISSUE_ID="${ISSUE_ID:?ISSUE_ID required}"
ROLE="${ROLE:-fullstack}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:9b}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
OLLAMA_CPU_URL="${OLLAMA_CPU_URL:-http://ollama-cpu:11434}"
SLOT_ID="${SLOT_ID:-}"
SCHEDULER_URL="${SCHEDULER_URL:-http://localhost:7070}"
NO_DEGRADE="${NO_DEGRADE:-false}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

OWNER="${REPO%%/*}"
REPO_NAME="${REPO##*/}"
WORKSPACE="/workspace/${REPO_NAME}"
OPENCLAW_DIR="/root/.openclaw"
CONFIG_FILE="${OPENCLAW_DIR}/openclaw.json"

log()  { echo "[worker/${ROLE}/#${ISSUE_ID}] $(date '+%H:%M:%S') $*"; }
fail() { log "ERROR: $*"; exit 1; }

cleanup() {
  if [ -n "$SLOT_ID" ]; then
    log "Releasing GPU slot ${SLOT_ID}..."
    curl -sf -X POST "${SCHEDULER_URL}/release" \
      -H "Content-Type: application/json" \
      -d "{\"slotId\":\"${SLOT_ID}\"}" || true
  fi
}
trap cleanup EXIT

# ── 1. Clone ──────────────────────────────────────────────────────────────
log "Cloning ${REPO}..."
mkdir -p /workspace
AUTH_URL="${FORGEJO_URL}/${REPO}.git"
AUTH_URL="${AUTH_URL/\/\//\/\/agent:${FORGEJO_TOKEN}@}"
git clone --depth=50 "$AUTH_URL" "$WORKSPACE" || fail "Clone failed"
cd "$WORKSPACE"
# Git identity — read from /git-config set (project > global > fallback)
GIT_ID_NAME="${AGENT_GIT_LOGIN:-agent}"
GIT_ID_EMAIL="${AGENT_GIT_LOGIN:-agent}@localhost"
PROJECT_GIT_CFG="${PROJECT_DATA_DIR}/${PROJECT_NAME}/.coderclaw/git-config.json"
GLOBAL_GIT_CFG="${PROJECT_DATA_DIR}/.coderclaw/git-config.json"
if [ -f "$PROJECT_GIT_CFG" ]; then
  GIT_ID_NAME=$(node -e "const c=JSON.parse(require('fs').readFileSync('$PROJECT_GIT_CFG','utf8'));console.log(c.agent?.name||'$GIT_ID_NAME')")
  GIT_ID_EMAIL=$(node -e "const c=JSON.parse(require('fs').readFileSync('$PROJECT_GIT_CFG','utf8'));console.log(c.agent?.email||'$GIT_ID_EMAIL')")
elif [ -f "$GLOBAL_GIT_CFG" ]; then
  GIT_ID_NAME=$(node -e "const c=JSON.parse(require('fs').readFileSync('$GLOBAL_GIT_CFG','utf8'));console.log(c.agent?.name||'$GIT_ID_NAME')")
  GIT_ID_EMAIL=$(node -e "const c=JSON.parse(require('fs').readFileSync('$GLOBAL_GIT_CFG','utf8'));console.log(c.agent?.email||'$GIT_ID_EMAIL')")
fi
git config user.email "$GIT_ID_EMAIL"
git config user.name  "$GIT_ID_NAME"
git config init.defaultBranch main
git config pull.rebase false
git config push.autoSetupRemote true
log "Git identity: $GIT_ID_NAME <$GIT_ID_EMAIL>"

# ── 2. Fetch the issue ───────────────────────────────────────────────────
log "Issue #${ISSUE_ID}..."
ISSUE=$(curl -sf \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  -H "Accept: application/json" \
  "${FORGEJO_URL}/api/v1/repos/${REPO}/issues/${ISSUE_ID}") \
  || fail "Unable to fetch the issue"

ISSUE_TITLE=$(echo "$ISSUE" | jq -r '.title')
ISSUE_BODY=$(echo  "$ISSUE" | jq -r '.body // ""')
log "Issue: ${ISSUE_TITLE}"

# ── 3. Main branch for the issue ─────────────────────────────────────────
# Check if a feature branch already exists on the user's repo (resume flow).
BRANCH_SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | \
  sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-40 | sed 's/-$//')

EXISTING_BRANCH=""
for prefix in features feat fix refactor test docs; do
  CANDIDATE="${prefix}/${ISSUE_ID}-${BRANCH_SLUG}"
  if git ls-remote --heads origin "$CANDIDATE" | grep -q "$CANDIDATE"; then
    EXISTING_BRANCH="$CANDIDATE"
    break
  fi
  # Also try prefix/issue-ID pattern (without slug)
  CANDIDATE="${prefix}/${ISSUE_ID}"
  if git ls-remote --heads origin "$CANDIDATE" | grep -q "$CANDIDATE"; then
    EXISTING_BRANCH="$CANDIDATE"
    break
  fi
done

# Fallback: check for the legacy agent/issue-xxx pattern
if [ -z "$EXISTING_BRANCH" ]; then
  CANDIDATE="agent/issue-${ISSUE_ID}-${BRANCH_SLUG}"
  if git ls-remote --heads origin "$CANDIDATE" | grep -q "$CANDIDATE"; then
    EXISTING_BRANCH="$CANDIDATE"
  fi
fi

if [ -n "$EXISTING_BRANCH" ]; then
  PARENT_BRANCH="$EXISTING_BRANCH"
  git fetch origin "$PARENT_BRANCH"
  git checkout "$PARENT_BRANCH"
  log "Resuming from existing branch: ${PARENT_BRANCH}"
else
  PARENT_BRANCH="agent/issue-${ISSUE_ID}-${BRANCH_SLUG}"
  git checkout -b "$PARENT_BRANCH"
  git push origin "$PARENT_BRANCH" --set-upstream
  log "Created new branch: ${PARENT_BRANCH}"
fi
log "Main branch: ${PARENT_BRANCH}"

export PARENT_BRANCH ISSUE_TITLE ISSUE_BODY ISSUE_ID REPO FORGEJO_TOKEN FORGEJO_URL
export OLLAMA_BASE_URL OLLAMA_MODEL OLLAMA_CPU_URL SCHEDULER_URL SLOT_ID GITHUB_TOKEN

# ── 4. Heuristic score + CPU gray zone analysis ─────────────────────────
HEURISTIC_SCORE=30
TEXT_LOWER=$(echo "${ISSUE_TITLE} ${ISSUE_BODY}" | tr '[:upper:]' '[:lower:]')

for KW in security auth migration database architecture refactor deploy infrastructure breaking cve; do
  echo "$TEXT_LOWER" | grep -q "$KW" && HEURISTIC_SCORE=$((HEURISTIC_SCORE + 15)) || true
done
for KW in feature api integration async cache algorithm search; do
  echo "$TEXT_LOWER" | grep -q "$KW" && HEURISTIC_SCORE=$((HEURISTIC_SCORE + 8)) || true
done
for KW in bug fix error crash regression test; do
  echo "$TEXT_LOWER" | grep -q "$KW" && HEURISTIC_SCORE=$((HEURISTIC_SCORE + 4)) || true
done
for KW in typo css style rename copy wording doc readme lint; do
  echo "$TEXT_LOWER" | grep -q "$KW" && HEURISTIC_SCORE=$((HEURISTIC_SCORE - 10)) || true
done
[ "${#ISSUE_BODY}" -gt 2000 ] && HEURISTIC_SCORE=$((HEURISTIC_SCORE + 10)) || true
[ "${#ISSUE_BODY}" -lt 100  ] && HEURISTIC_SCORE=$((HEURISTIC_SCORE - 5))  || true
[ "$HEURISTIC_SCORE" -gt 100 ] && HEURISTIC_SCORE=100 || true
[ "$HEURISTIC_SCORE" -lt 0   ] && HEURISTIC_SCORE=0   || true
log "Score: ${HEURISTIC_SCORE}/100"

STRUCTURED_CONTEXT=""
CPU_DECOMPOSABLE="false"

if echo "fullstack backend frontend devops" | grep -qw "$ROLE" && \
   [ "$HEURISTIC_SCORE" -ge 45 ] && [ "$HEURISTIC_SCORE" -le 75 ] && \
   [ "$NO_DEGRADE" = "false" ]; then

  log "Gray zone — CPU analysis..."
  ISSUE_BODY_SHORT=$(echo "$ISSUE_BODY" | head -c 500)

  CPU_RESPONSE=$(curl -sf --max-time 30 -X POST "${OLLAMA_CPU_URL}/api/generate" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg p "Analyze this issue. Respond ONLY in JSON without surrounding text.
Issue: \"${ISSUE_TITLE}\"
Description: \"${ISSUE_BODY_SHORT}\"
Score: ${HEURISTIC_SCORE}/100
{\"score\":<0-100>,\"degrade\":<bool>,\"estimatedFiles\":<int>,\"affectedModules\":[\"...\"],\"acceptanceCriteria\":[\"...\"],\"decomposable\":<bool>,\"subtaskHint\":\"...\"}" \
      '{model:"qwen3.5:0.8b",prompt:$p,stream:false,keep_alive:0,options:{num_gpu:0,num_predict:250,temperature:0}}'
    )" 2>/dev/null || echo "")

  if [ -n "$CPU_RESPONSE" ]; then
    CPU_JSON=$(echo "$CPU_RESPONSE" | jq -r '.response // ""' | \
      sed 's/```json//g;s/```//g' | grep -o '{.*}' | head -1)
    if echo "$CPU_JSON" | jq -e '.score' > /dev/null 2>&1; then
      CPU_SCORE=$(echo "$CPU_JSON" | jq -r '.score           // 50')
      CPU_FILES=$(echo "$CPU_JSON" | jq -r '.estimatedFiles  // 1')
      CPU_MODS=$( echo "$CPU_JSON" | jq -r '.affectedModules | join(", ") // ""')
      CPU_CRIT=$( echo "$CPU_JSON" | jq -r '.acceptanceCriteria | join("\n  - ") // ""')
      CPU_DECOMPOSABLE=$(echo "$CPU_JSON" | jq -r '.decomposable // false')
      HEURISTIC_SCORE=$CPU_SCORE
      STRUCTURED_CONTEXT="
## Structured analysis
- Score: ${CPU_SCORE}/100 — Estimated files: ${CPU_FILES}
- Modules: ${CPU_MODS}
- Criteria:
  - ${CPU_CRIT}
- Decomposable into subtasks: ${CPU_DECOMPOSABLE}"
      log "CPU → score=${CPU_SCORE} files=${CPU_FILES} decomposable=${CPU_DECOMPOSABLE}"
    fi
  fi
fi

export STRUCTURED_CONTEXT CPU_DECOMPOSABLE

# ── 5. BMAD context ──────────────────────────────────────────────────────
BMAD_CONTEXT=""
for BMAD_DIR in docs/bmad .bmad bmad; do
  if [ -d "$WORKSPACE/$BMAD_DIR" ]; then
    BMAD_CONTEXT=$(find "$WORKSPACE/$BMAD_DIR" -name "*.md" -exec cat {} \; 2>/dev/null | head -c 6000)
    log "BMAD context: ${BMAD_DIR}/"
    break
  fi
done
export BMAD_CONTEXT

# ── 6. Generate openclaw.json ────────────────────────────────────────────
mkdir -p "$OPENCLAW_DIR/workspace/memory" "$OPENCLAW_DIR/memory"
touch "$OPENCLAW_DIR/.onboarded"

if [ ! -f "$OPENCLAW_DIR/.gateway_token" ]; then
  node -e "require('fs').writeFileSync('${OPENCLAW_DIR}/.gateway_token', require('crypto').randomBytes(32).toString('hex'))"
fi
GATEWAY_TOKEN=$(cat "$OPENCLAW_DIR/.gateway_token")
export GATEWAY_TOKEN CONFIG_FILE OPENCLAW_DIR WORKSPACE

node /opt/worker/gen-config.js || fail "openclaw.json generation failed"

# ── 7. Install skills ────────────────────────────────────────────────────
mkdir -p "$OPENCLAW_DIR/skills"

for skill in git-flow agent-fanout loop-detect codebase-analyze \
             session-handoff semantic-memory project-context frontend-design forget; do
  [ -d "/opt/skills/${skill}" ] && \
    cp -r "/opt/skills/${skill}" "$OPENCLAW_DIR/skills/${skill}" && \
    log "Skill ${skill} installed"
done

mkdir -p /opt/agent-fanout
cp /opt/skills/agent-fanout/scripts/run-subagent.js /opt/agent-fanout/
cp /opt/skills/agent-fanout/scripts/fanin-wait.js   /opt/agent-fanout/

export PROJECT_DATA_DIR="${PROJECT_DATA_DIR:-/projects}"
export PROJECT_NAME="${PROJECT_NAME:-$(echo "$REPO" | tr '/' '_')}"
export STAGED_MODE="false"   # headless — direct commits without staged-diff
export SURFACE="worker"
export WORKSPACE="${WORKSPACE:-/workspace/$(echo "$REPO" | cut -d/ -f2)}"

# ── 8. Incremental codebase index ────────────────────────────────────────
# Updates only files modified since the last index.
# Full scan on first run (missing index), otherwise git-diff based.
if [ -f "/opt/skills/codebase-analyze/incremental-index.js" ] && [ -d "$WORKSPACE" ]; then
  log "Updating codebase index (incremental)..."
  node /opt/skills/codebase-analyze/incremental-index.js 2>/dev/null || \
    log "Codebase index: warning (non-blocking)" WARN
fi

# ── 9. Start headless OpenClaw agent ─────────────────────────────────────
AGENT_ID="worker-${ROLE}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://openclaw-agent:9001}"
log "Headless OpenClaw agent → ${AGENT_ID}"

openclaw agent start \
  --config   "$CONFIG_FILE" \
  --agent-id "$AGENT_ID"   \
  --headless                \
  --exit-on-idle 120        \
  --workspace "$WORKSPACE"

EXIT_CODE=$?

# ── 10. Report gate result to orchestrator ─────────────────────────────
RESULT="done"
[ $EXIT_CODE -ne 0 ] && RESULT="fail"

log "Gate ${ROLE} finished with result=${RESULT} (exit=${EXIT_CODE})"
curl -sf -X POST "${ORCHESTRATOR_URL}/gate-complete" \
  -H "Content-Type: application/json" \
  -d "{\"repo\":\"${REPO}\",\"issueId\":${ISSUE_ID},\"role\":\"${ROLE}\",\"result\":\"${RESULT}\",\"summary\":\"Exit code: ${EXIT_CODE}\"}" \
  2>/dev/null || log "Failed to report gate result (non-blocking)" WARN

exit $EXIT_CODE
