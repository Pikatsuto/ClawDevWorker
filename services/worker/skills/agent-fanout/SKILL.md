---
name: agent-fanout
description: "Décompose une issue complexe en sous-tâches indépendantes et lance des sub-agents OpenClaw en parallèle. Utilise ce skill quand l'issue implique plusieurs modules distincts, plusieurs fichiers sans dépendances entre eux, ou plusieurs fonctionnalités logiquement séparables. Chaque sub-agent travaille sur sa propre branche et ouvre ses propres PRs. Ne pas utiliser si les tâches sont séquentielles ou dépendantes les unes des autres."
metadata: {"openclaw":{"emoji":"🔀","requires":{"bins":["node","curl","jq"],"env":["SCHEDULER_URL","FORGEJO_TOKEN","FORGEJO_URL","REPO","ISSUE_ID","PARENT_BRANCH","OLLAMA_BASE_URL","OLLAMA_MODEL"]}}}
user-invocable: false
---

# agent-fanout — Fan-out de sub-agents dans le worker

## Quand décomposer

**Décomposer si l'issue :**
- Mentionne explicitement plusieurs modules/composants distincts
- Peut être découpée en N tâches sans ordre imposé entre elles
- Contient des mots comme : "chaque", "tous les", "pour chaque module", "et aussi"
- Implique plus de 5 fichiers dans des répertoires différents

**Ne PAS décomposer si :**
- Les tâches sont séquentielles ("d'abord X, puis Y")
- Une tâche dépend du résultat d'une autre
- L'issue est simple (< 3 fichiers, 1 module)
- Le contexte BMAD interdit explicitement la parallélisation

## Analyse de décomposabilité (CPU)

Avant de décomposer, valide avec le modèle CPU :

```bash
DECOMPOSE_CHECK=$(curl -sf -X POST "${OLLAMA_CPU_URL:-http://ollama-cpu:11434}/api/generate" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg prompt "Analyse cette issue et dis si elle peut être décomposée en sous-tâches INDÉPENDANTES (sans dépendances entre elles).

Issue : \"${ISSUE_TITLE}\"
Description : \"${ISSUE_BODY_SHORT}\"

Réponds UNIQUEMENT en JSON :
{
  \"decomposable\": true/false,
  \"reason\": \"explication courte\",
  \"subtasks\": [
    {\"id\": \"task-1\", \"scope\": \"module ou fichiers concernés\", \"type\": \"feat|fix|refactor|test\", \"description\": \"ce que fait cette sous-tâche\"},
    ...
  ]
}
Si decomposable=false, subtasks=[]." \
    '{model:"qwen3.5:0.8b", prompt:$prompt, stream:false, keep_alive:0, options:{num_gpu:0,num_predict:300,temperature:0}}'
  )" | jq -r '.response // ""' | grep -o '{.*}' | head -1)

DECOMPOSABLE=$(echo "$DECOMPOSE_CHECK" | jq -r '.decomposable // false')
SUBTASKS=$(echo "$DECOMPOSE_CHECK" | jq -r '.subtasks // []')
SUBTASK_COUNT=$(echo "$SUBTASKS" | jq 'length')
```

Si `decomposable=false` ou `subtask_count < 2` → traiter l'issue normalement sans fan-out.

## Procédure de fan-out

### 1. Préparer les branches sub-agents

```bash
DISPATCH_ID="fanout-${ISSUE_ID}-$(date +%s)"

# Pour chaque sous-tâche identifiée
for task in $(echo "$SUBTASKS" | jq -c '.[]'); do
  TASK_ID=$(echo "$task" | jq -r '.id')
  TASK_TYPE=$(echo "$task" | jq -r '.type')
  TASK_SCOPE=$(echo "$task" | jq -r '.scope' | tr ' /' '--' | tr '[:upper:]' '[:lower:]' | cut -c1-20)
  TASK_DESC=$(echo "$task" | jq -r '.description')

  # Branche du sub-agent : part de PARENT_BRANCH
  SUB_BRANCH="${TASK_TYPE}/${ISSUE_ID}-${TASK_SCOPE}"

  git checkout "${PARENT_BRANCH}"
  git checkout -b "${SUB_BRANCH}" 2>/dev/null || git checkout "${SUB_BRANCH}"
  git push origin "${SUB_BRANCH}" --set-upstream 2>/dev/null || true
  git checkout "${PARENT_BRANCH}"

  echo "Branche sub-agent créée : ${SUB_BRANCH}"
done
```

### 2. Demander les slots GPU au scheduler

```bash
# Réserve N slots — un par sous-tâche
SLOT_REQUEST=$(curl -sf -X POST "${SCHEDULER_URL}/chat/fanout" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --argjson count "$SUBTASK_COUNT" \
    --arg surface "agent" \
    '{subtasks: [range($count) | {messages:[], surface:"agent"}], surface: $surface}'
  )")

echo "Slots GPU alloués : $(echo "$SLOT_REQUEST" | jq '.subtasks | length')"
```

### 3. Lancer les sub-agents en background

Pour chaque sous-tâche, lancer un sub-agent OpenClaw isolé :

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

  # Slot GPU pour ce sub-agent
  SLOT=$(echo "$SLOT_REQUEST" | jq -c ".subtasks[${IDX}]")
  SUB_MODEL=$(echo "$SLOT"   | jq -r '.model // env.OLLAMA_MODEL')
  SUB_OLLAMA=$(echo "$SLOT"  | jq -r '.ollamaUrl // env.OLLAMA_BASE_URL')
  SUB_SLOT_ID=$(echo "$SLOT" | jq -r '.slotId // ""')

  RESULT_FILE="${RESULTS_DIR}/${TASK_ID}.json"
  EPHEMERAL_DIR="/tmp/${DISPATCH_ID}/${TASK_ID}"
  mkdir -p "$EPHEMERAL_DIR"

  # Dossier de workspace isolé — lecture du repo, écriture dans éphémère uniquement
  # Le sub-agent reçoit comme workspace le repo cloné en read-only
  # Il ne peut écrire que dans EPHEMERAL_DIR
  # Git push est autorisé sur SUB_BRANCH uniquement

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

### 4. Attendre le fan-in

```bash
node /opt/agent-fanout/fanin-wait.js \
  --results-dir "$RESULTS_DIR" \
  --expected-count "$SUBTASK_COUNT" \
  --timeout 300
```

### 5. Agréger et ouvrir la PR principale

Une fois tous les sub-agents terminés :

```bash
# Collecter les résultats
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

# PR principale issue → main
curl -sf -X POST \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  -H "Content-Type: application/json" \
  "${FORGEJO_URL}/api/v1/repos/${REPO}/pulls" \
  -d "$(jq -n \
    --arg title "Issue #${ISSUE_ID}: ${ISSUE_TITLE}" \
    --arg body  "Closes #${ISSUE_ID}\n\n## Résumé\n${SUMMARY}\n\n## PRs atomiques\n${PR_LIST}" \
    --arg head  "${PARENT_BRANCH}" \
    --arg base  "main" \
    '{title:$title, body:$body, head:$head, base:$base}'
  )"

# Nettoyage
rm -rf "/tmp/${DISPATCH_ID}"
```

## Sécurité des sub-agents

Chaque sub-agent :
- Lecture : tout le repo cloné (read-only pour les fichiers existants)
- Écriture : uniquement dans son `EPHEMERAL_DIR` pour le scratchpad, et via `git` sur `SUB_BRANCH` uniquement
- Réseau : Forgejo + Ollama + mcp-docs via proxy
- Ne peut PAS pousser sur `main`, `develop`, ou d'autres branches que `SUB_BRANCH`
- Ne peut PAS merger de PR
- Ne peut PAS modifier la config infrastructure

## Limites

- Maximum 4 sub-agents en parallèle (limite VRAM conservative)
- Timeout par sub-agent : 300 secondes
- Si un sub-agent échoue : son résultat est marqué `{status:"failed"}`, les autres continuent
- Si < 2 sous-tâches identifiées : ne pas fan-out, traiter normalement
