---
name: loop-detect
description: "Détecte et interrompt les boucles infinies : même erreur répétée, même fichier modifié sans progrès, même commande échouant en boucle. Utilise ce skill AUTOMATIQUEMENT quand tu sens que tu tourne en rond, que tu refais la même chose sans avancer, ou que tu as échoué plus de 2 fois sur la même tâche. En VSCode : demande de l'aide à l'humain. En worker headless : signale FAIL avec résumé détaillé."
metadata: {"openclaw":{"emoji":"🔁","always":true}}
user-invocable: false
---

# loop-detect — Auto-détection de boucle infinie

## Signaux d'alerte — tu dois t'arrêter si :

1. **Tu modifies le même fichier plus de 3 fois** pour corriger la même erreur
2. **La même commande échoue plus de 2 fois** avec le même type d'erreur
3. **Les tests échouent encore** après 2 cycles correction → test → correction
4. **Tu relis les mêmes instructions** en cherchant quelque chose qui n'y est pas
5. **Tu génères du code qui reproduit une erreur** que tu avais déjà corrigée
6. **Le diff de tes changements est vide** après avoir "corrigé"

## Procédure de détection automatique

Avant chaque nouvelle tentative de correction, vérifie :

```bash
# Historique git récent — est-ce qu'on tourne en rond ?
RECENT=$(git -C "$WORKSPACE" log --oneline -10 2>/dev/null || echo "")
echo "$RECENT"

# Fichiers modifiés plusieurs fois dans la session
CHANGED_FILES=$(git -C "$WORKSPACE" diff --name-only HEAD~5 HEAD 2>/dev/null | sort | uniq -d)
if [ -n "$CHANGED_FILES" ]; then
  TOUCH_COUNT=$(echo "$CHANGED_FILES" | wc -l)
  echo "⚠️ Fichiers modifiés plusieurs fois : $CHANGED_FILES"
fi

# Même message d'erreur dans les derniers commits ?
LAST_MSGS=$(git -C "$WORKSPACE" log --format="%s" -5 2>/dev/null)
echo "Derniers commits : $LAST_MSGS"
```

## Action selon la surface

### En VSCode (session interactive)

Quand une boucle est détectée, **arrête immédiatement** et demande de l'aide :

```
🔁 **Boucle détectée — j'ai besoin d'aide**

J'ai essayé N fois de corriger [description du problème] sans succès.

**Ce que j'ai tenté :**
1. [tentative 1]
2. [tentative 2]
3. [tentative 3]

**Où je bloque :**
[description précise du problème qui résiste]

**Fichiers concernés :**
- [fichier 1]
- [fichier 2]

Peux-tu m'indiquer la bonne direction ou regarder le code avec moi ?
```

Ne continue jamais après ce message sans réponse humaine.

### En worker headless (Forgejo/GitHub)

Appelle immédiatement `task_complete` avec `result: "fail"` et un résumé détaillé :

```bash
# Résumé pour task_complete
LOOP_SUMMARY="🔁 Boucle infinie détectée après N tentatives.

**Problème :** [description]
**Dernières tentatives :**
$(git -C "$WORKSPACE" log --oneline -5 2>/dev/null)

**Erreur persistante :**
[message d'erreur exact]

**Fichiers impliqués :**
$(git -C "$WORKSPACE" diff --name-only HEAD~3 HEAD 2>/dev/null)"

# Signaler via task_complete
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

## Compteur de tentatives (state local)

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

# Exemple d'utilisation :
ATTEMPTS=$(increment_attempt "fix_auth_middleware")
if [ "$ATTEMPTS" -ge 3 ]; then
  echo "⚠️ 3 tentatives sur fix_auth_middleware — détection boucle active"
fi
```

## Règle absolue

**Tu n'essaies JAMAIS une 4ème tentative de correction du même problème.**
Après 3 échecs : arrêt + demande d'aide (VSCode) ou FAIL + résumé (worker).
