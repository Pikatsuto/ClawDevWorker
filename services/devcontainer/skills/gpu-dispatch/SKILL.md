---
name: gpu-dispatch
description: "Lance des sous-tâches indépendantes en parallèle via des sub-agents OpenClaw isolés. Utilise ce skill quand l'utilisateur demande d'analyser, lire ou rechercher sur plusieurs fichiers/sources simultanément — ex: 'analyse ces 3 modules', 'cherche dans ces fichiers', 'documente chaque fichier de ce dossier'. Chaque sous-tâche tourne dans un sub-agent background avec son propre dossier éphémère en écriture, lecture du workspace en lecture seule, accès mcp-docs pour la recherche. Ne pas utiliser si le message contient 'séquentiellement', 'dans l'ordre', 'd'abord puis', 'étape par étape'."
metadata: {"openclaw":{"emoji":"⚡","requires":{"bins":["node","curl"],"env":["SCHEDULER_URL"]}}}
user-invocable: false
---

# gpu-dispatch — Fan-out sub-agents isolés

## Quand l'utiliser

Détecte les requêtes parallélisables :
- Liste explicite de fichiers ou modules à traiter
- Mots-clés : "chaque", "tous les", "pour chacun", "chaque fichier", "each file", "for each"
- Patterns : "analyse X et Y et Z", "documente ces fichiers", "refactorise ces modules"

Ne pas paralléliser si le message contient : "séquentiellement", "dans l'ordre", "d'abord puis",
"étape par étape", "step by step", "one by one", "un par un".

## Procédure

### 1. Identifier les sous-tâches

Découpe la requête en N tâches indépendantes. Chaque tâche doit être autonome — elle ne dépend
pas du résultat des autres. Si les tâches sont séquentielles ou dépendantes, réponds normalement
sans fan-out.

### 2. Vérifier la disponibilité GPU

```bash
curl -sf "${SCHEDULER_URL}/health" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); process.stdout.write(j.mode + ' vram=' + (j.totalFree||'?') + 'GB\n')" 2>/dev/null || echo "scheduler indisponible"
```

Si le scheduler est indisponible, traite les tâches séquentiellement en répondant normalement.

### 3. Préparer le dossier éphémère partagé

```bash
DISPATCH_ID="dispatch-$(date +%s)"
SHARED_DIR="/tmp/${DISPATCH_ID}"
mkdir -p "${SHARED_DIR}/results"
echo "Dossier éphémère : ${SHARED_DIR}"
```

### 4. Lancer les sub-agents en background

Pour chaque sous-tâche, lance un sub-agent OpenClaw avec :
- Son propre dossier éphémère en écriture : `/tmp/${DISPATCH_ID}/task-N/`
- Accès lecture seule au workspace courant
- Accès mcp-docs pour la recherche
- Instruction de sauvegarder son résultat dans `/tmp/${DISPATCH_ID}/results/task-N.md`
- Notification de fin via `openclaw system event`

```bash
# Crée le dossier isolé pour la sous-tâche N
mkdir -p "/tmp/${DISPATCH_ID}/task-N"

# Lance le sub-agent
bash pty:false background:true timeout:120 command:"node /opt/stream-proxy/run-subagent.js \
  --task-id task-N \
  --dispatch-id ${DISPATCH_ID} \
  --workspace-read-only ${WORKSPACE_DIR} \
  --ephemeral-dir /tmp/${DISPATCH_ID}/task-N \
  --result-file /tmp/${DISPATCH_ID}/results/task-N.md \
  --prompt 'TÂCHE ISOLÉE — lecture seule du workspace, écriture uniquement dans /tmp/${DISPATCH_ID}/task-N/\n\nTâche : [description de la sous-tâche N]\n\nQuand tu as terminé, écris ton résultat complet dans /tmp/${DISPATCH_ID}/results/task-N.md'"
```

**Règles de sécurité transmises à chaque sub-agent :**
- Lecture : tous les fichiers du workspace courant en lecture seule
- Écriture : UNIQUEMENT dans `/tmp/${DISPATCH_ID}/task-N/` — refuser toute écriture ailleurs
- Exécution : autorisée uniquement si explicitement nécessaire pour lire/analyser (ex: `cat`, `grep`,
  `find`, `git log`, `git diff` — jamais `rm`, `mv`, `git commit`, `git push`, ni modification
  de fichiers hors du dossier éphémère)
- Réseau : accès mcp-docs uniquement (searxng, devdocs, browserless via proxy)

### 5. Attendre les résultats (fan-in)

Attends que tous les sub-agents aient écrit leur fichier résultat :

```bash
# Script de fan-in — attend tous les fichiers résultats avec timeout
node /opt/stream-proxy/fanin-wait.js \
  --results-dir "/tmp/${DISPATCH_ID}/results" \
  --expected-count N \
  --timeout 120
```

### 6. Agréger et répondre

Une fois tous les résultats disponibles, lis chaque fichier et compose la réponse finale :

```bash
for f in /tmp/${DISPATCH_ID}/results/*.md; do
  echo "=== $(basename $f .md) ==="
  cat "$f"
  echo ""
done
```

Présente les résultats agrégés dans un seul bloc structuré. Si une sous-tâche a échoué
(fichier absent ou contenant une erreur), signale-le clairement sans bloquer les autres.

### 7. Nettoyage

```bash
rm -rf "/tmp/${DISPATCH_ID}"
```

## Limites

- Maximum 6 sous-tâches en parallèle (limite slots GPU)
- Timeout par sous-tâche : 120 secondes
- Si une sous-tâche dépasse le timeout, son résultat est marqué "⏱ Timeout" dans l'agrégation
- Les sub-agents ne peuvent PAS se parler entre eux pendant l'exécution
- Les sub-agents ne peuvent PAS modifier le workspace courant ni les fichiers ouverts dans VSCode

## Exemple concret

Requête : "Analyse la complexité cyclomatique de src/api.js, src/utils.js et src/auth.js"

→ 3 sous-tâches indépendantes :
  - task-1 : Analyse src/api.js (lecture + analyse statique)
  - task-2 : Analyse src/utils.js (lecture + analyse statique)
  - task-3 : Analyse src/auth.js (lecture + analyse statique)

→ Fan-out : 3 sub-agents lancés en background
→ Fan-in : agrégation quand les 3 résultats sont disponibles
→ Réponse : tableau comparatif des 3 fichiers
