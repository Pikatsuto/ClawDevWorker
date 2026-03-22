---
name: cpu-status
description: "Gère l'affichage du statut de fallback CPU et la commande /wait-gpu. Utilise ce skill automatiquement quand une réponse arrive avec le header X-Fallback-CPU ou quand l'utilisateur tape /wait-gpu. Informe l'utilisateur que le modèle GPU est indisponible et que la réponse est générée par le modèle CPU réduit. Permet d'annuler et d'attendre un slot GPU."
metadata: {"openclaw":{"emoji":"⚡","always":true}}
user-invocable: true
---

# cpu-status — Statut fallback CPU

## Détection automatique du fallback CPU

Quand tu reçois une réponse dont les métadonnées ou le contexte système indiquent
`X-Fallback-CPU: true` ou `fallback: true`, **avant de présenter la réponse**, affiche
ce bandeau en tête de ta réponse :

```
⚡ **Réponse CPU — modèle réduit** (`qwen3.5:0.8b`)
Le GPU est actuellement utilisé. Cette réponse est générée par le modèle CPU de secours.
Tape `/wait-gpu` pour annuler et attendre un slot GPU (réponse de meilleure qualité).
---
```

Puis présente la réponse normalement sous ce bandeau.

## Slash command : /wait-gpu

Quand l'utilisateur tape `/wait-gpu` :

### 1. Confirmer l'annulation

Réponds immédiatement :
```
⏳ Annulation du stream CPU en cours...
Je mets ta requête en attente d'un slot GPU.
Je te préviendrai dès qu'un modèle GPU est disponible.
```

### 2. Appeler le proxy pour annuler et attendre

```bash
curl -sf -X POST http://localhost:11435/cancel-and-wait \
  -H "Content-Type: application/json" \
  -d '{"requestId":"'"${LAST_REQUEST_ID:-unknown}"'","messages":[],"waitForGpu":true}' \
  --no-buffer 2>/dev/null &
WAIT_PID=$!
echo "En attente GPU (PID=$WAIT_PID)..."
```

### 3. Attendre la notification GPU

Poll le statut du scheduler toutes les 10 secondes et informe l'utilisateur :

```bash
PROXY_URL="${PROXY_URL:-http://localhost:11435}"
SCHEDULER_URL="${SCHEDULER_URL:-http://openclaw-agent:7070}"
MAX_WAIT=300  # 5 minutes max

for i in $(seq 1 $((MAX_WAIT/10))); do
  sleep 10
  STATUS=$(curl -sf "${SCHEDULER_URL}/status" 2>/dev/null)
  FREE=$(echo "$STATUS" | node -e \
    "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
     try{const j=JSON.parse(d); process.stdout.write(String(j.totalFree||0));}catch{process.stdout.write('?');}" \
    2>/dev/null)
  
  if [ "$FREE" != "0" ] && [ "$FREE" != "?" ]; then
    echo "✅ Slot GPU disponible (${FREE}GB VRAM libre) — tu peux renvoyer ta question."
    exit 0
  fi
  echo "⏳ Toujours en attente... (${i}0s écoulées, VRAM libre: ${FREE}GB)"
done

echo "⚠️ Timeout d'attente GPU dépassé (5min). Tu peux réessayer maintenant ou continuer en CPU."
```

### 4. Notifier l'utilisateur

Quand un slot GPU est disponible, affiche :
```
✅ **Slot GPU disponible !**
Tu peux maintenant renvoyer ta question — elle sera traitée par le modèle GPU complet.
```

## Informations sur les modèles

Si l'utilisateur demande quel modèle est utilisé :

```bash
curl -sf "${SCHEDULER_URL:-http://openclaw-agent:7070}/status" | \
  node -e "
    const d = require('fs').readFileSync('/dev/stdin','utf8');
    try {
      const j = JSON.parse(d);
      const loaded = j.loadedModels || [];
      const chat   = j.chatSlots   || [];
      console.log('=== Statut GPU ===');
      console.log('VRAM libre :', j.totalFree + '/' + j.totalVram + 'GB');
      console.log('Mode :', j.mode);
      console.log('Surface active :', j.activeSurface || 'aucune');
      if (loaded.length) {
        console.log('Modèles chargés :');
        loaded.forEach(m => console.log(' -', m.modelId, m.vram+'GB', m.agents+'/'+m.maxAgents, 'agents'));
      }
    } catch(e) { console.log('Scheduler indisponible'); }
  " 2>/dev/null || echo "Scheduler indisponible"
```

Présente ces informations de façon lisible à l'utilisateur.

## Slash command : /gpu-status

Quand l'utilisateur tape `/gpu-status`, exécute la commande ci-dessus et affiche le statut
complet du scheduler de façon formatée.

## Règles importantes

- N'affiche le bandeau CPU que quand le fallback est réellement actif — pas à chaque message
- Le slash `/wait-gpu` n'a de sens que si un stream CPU est en cours ou vient de se terminer
- Ne relance pas automatiquement la requête sans confirmation explicite de l'utilisateur
- Si le scheduler est indisponible, informe l'utilisateur que le statut GPU n'est pas accessible
