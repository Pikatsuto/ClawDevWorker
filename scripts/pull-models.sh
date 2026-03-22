#!/usr/bin/env bash
###############################################################################
# pull-models.sh — Télécharge et configure tous les modèles Qwen3.5
#
# Usage :
#   bash scripts/pull-models.sh
#   bash scripts/pull-models.sh --ollama-url http://localhost:11434
#   bash scripts/pull-models.sh --cpu-url http://localhost:11435
#
# Ce script fait :
#   1. Pull des modèles standard depuis le registry Ollama
#      (qwen3.5:9b, qwen3.5:4b, qwen3.5:2b, qwen3.5:0.8b)
#   2. Télécharge qwen3.5:27b-q3_k_m depuis HuggingFace (Unsloth)
#      et l'importe dans Ollama via un Modelfile
#   3. Pull qwen3.5:0.8b sur l'instance CPU (ollama-cpu)
###############################################################################

set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_CPU_URL="${OLLAMA_CPU_URL:-http://localhost:11435}"
GGUF_CACHE_DIR="${GGUF_CACHE_DIR:-/tmp/gguf-cache}"

log()  { echo "[pull-models] $(date '+%H:%M:%S') $*"; }
ok()   { echo "[pull-models] ✅ $*"; }
warn() { echo "[pull-models] ⚠️  $*" >&2; }
fail() { echo "[pull-models] ❌ $*" >&2; exit 1; }

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ollama-url)   OLLAMA_URL="$2";     shift 2 ;;
    --cpu-url)      OLLAMA_CPU_URL="$2"; shift 2 ;;
    --cache-dir)    GGUF_CACHE_DIR="$2"; shift 2 ;;
    *) warn "Argument inconnu : $1"; shift ;;
  esac
done

# ── Attendre qu'Ollama soit prêt ─────────────────────────────────────────────
wait_ollama() {
  local url="$1"
  local name="${2:-ollama}"
  log "Attente de ${name} (${url})..."
  for i in $(seq 1 30); do
    curl -sf "${url}/api/tags" > /dev/null 2>&1 && return 0
    sleep 2
  done
  fail "${name} non joignable après 60s"
}

# ── Pull standard depuis le registry Ollama ──────────────────────────────────
ollama_pull() {
  local url="$1"
  local model="$2"
  log "Pull ${model}..."
  curl -sf -X POST "${url}/api/pull" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${model}\",\"stream\":false}" \
    | grep -q '"status":"success"' \
    && ok "${model} prêt" \
    || fail "Echec pull ${model}"
}

# ── Vérifier si un modèle est déjà présent ───────────────────────────────────
model_exists() {
  local url="$1"
  local model="$2"
  curl -sf "${url}/api/tags" 2>/dev/null \
    | grep -q "\"name\":\"${model}\"" \
    && return 0 || return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. Modèles standard (registry Ollama)
# ─────────────────────────────────────────────────────────────────────────────
wait_ollama "$OLLAMA_URL" "ollama-gpu"

for model in qwen3.5:9b qwen3.5:4b qwen3.5:2b; do
  if model_exists "$OLLAMA_URL" "$model"; then
    ok "${model} déjà présent — skip"
  else
    ollama_pull "$OLLAMA_URL" "$model"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# 2. qwen3.5:27b-q3_k_m depuis HuggingFace (Unsloth)
#    Fichier : Qwen3.5-27B-Q3_K_M.gguf (13.5GB)
#    Repo    : unsloth/Qwen3.5-27B-GGUF
# ─────────────────────────────────────────────────────────────────────────────

Q27B_MODEL="qwen3.5:27b-q3_k_m"
Q27B_GGUF="Qwen3.5-27B-Q3_K_M.gguf"
Q27B_URL="https://huggingface.co/unsloth/Qwen3.5-27B-GGUF/resolve/main/${Q27B_GGUF}"
Q27B_LOCAL="${GGUF_CACHE_DIR}/${Q27B_GGUF}"

if model_exists "$OLLAMA_URL" "$Q27B_MODEL"; then
  ok "${Q27B_MODEL} déjà présent — skip"
else
  log "=== Téléchargement ${Q27B_GGUF} (13.5GB) depuis HuggingFace ==="
  log "URL : ${Q27B_URL}"
  log "Destination : ${Q27B_LOCAL}"

  mkdir -p "$GGUF_CACHE_DIR"

  # Téléchargement avec reprise si interrompu
  if [ -f "$Q27B_LOCAL" ]; then
    EXISTING_SIZE=$(stat -c%s "$Q27B_LOCAL" 2>/dev/null || echo 0)
    log "Fichier partiel détecté (${EXISTING_SIZE} bytes) — reprise..."
    curl -L -C - \
      --retry 5 --retry-delay 10 \
      -H "User-Agent: Mozilla/5.0" \
      --progress-bar \
      -o "$Q27B_LOCAL" \
      "$Q27B_URL" \
    || fail "Téléchargement échoué"
  else
    curl -L \
      --retry 5 --retry-delay 10 \
      -H "User-Agent: Mozilla/5.0" \
      --progress-bar \
      -o "$Q27B_LOCAL" \
      "$Q27B_URL" \
    || fail "Téléchargement échoué"
  fi

  FINAL_SIZE=$(stat -c%s "$Q27B_LOCAL" 2>/dev/null || echo 0)
  log "Téléchargement terminé : ${FINAL_SIZE} bytes"

  if [ "$FINAL_SIZE" -lt 10000000000 ]; then
    fail "Fichier trop petit (${FINAL_SIZE} bytes) — téléchargement incomplet"
  fi

  # Créer le Modelfile
  MODELFILE=$(mktemp)
  cat > "$MODELFILE" << MODELFILE_EOF
FROM ${Q27B_LOCAL}

# Qwen3.5-27B quantisé Q3_K_M (13.5GB) — via Unsloth/HuggingFace
# Thinking mode activé par défaut sur les modèles Qwen3.5 Medium

PARAMETER num_ctx 8192
PARAMETER temperature 0.6
PARAMETER top_p 0.95
PARAMETER top_k 20
PARAMETER min_p 0.0
PARAMETER repeat_penalty 1.0

SYSTEM "You are a helpful assistant."
MODELFILE_EOF

  log "Import dans Ollama via Modelfile..."
  curl -sf -X POST "${OLLAMA_URL}/api/create" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${Q27B_MODEL}\",\"modelfile\":$(cat "$MODELFILE" | jq -Rs .)}" \
    | grep -q '"status"' \
    && ok "${Q27B_MODEL} importé avec succès" \
    || fail "Echec import ${Q27B_MODEL}"

  rm -f "$MODELFILE"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. qwen3.5:0.8b sur l'instance CPU
# ─────────────────────────────────────────────────────────────────────────────
log "=== Instance CPU ==="
wait_ollama "$OLLAMA_CPU_URL" "ollama-cpu"

if model_exists "$OLLAMA_CPU_URL" "qwen3.5:0.8b"; then
  ok "qwen3.5:0.8b déjà présent sur CPU — skip"
else
  ollama_pull "$OLLAMA_CPU_URL" "qwen3.5:0.8b"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Récap final
# ─────────────────────────────────────────────────────────────────────────────
echo ""
log "=== Modèles GPU disponibles ==="
curl -sf "${OLLAMA_URL}/api/tags" \
  | grep -o '"name":"[^"]*"' \
  | sed 's/"name":"//;s/"//' \
  | grep "qwen3.5" \
  | while read -r m; do echo "  ✅ ${m}"; done

echo ""
log "=== Modèles CPU disponibles ==="
curl -sf "${OLLAMA_CPU_URL}/api/tags" \
  | grep -o '"name":"[^"]*"' \
  | sed 's/"name":"//;s/"//' \
  | grep "qwen3.5" \
  | while read -r m; do echo "  ✅ ${m}"; done

echo ""
ok "Tous les modèles sont prêts."
log "Prochain démarrage du scheduler : les modèles seront chargés à la demande."
