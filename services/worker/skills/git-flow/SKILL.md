---
name: git-flow
description: "Gère le git flow propre pour chaque modification de code. Utilise ce skill pour CHAQUE écriture de fichier — commit atomique immédiat après chaque changement logique. Crée les branches feature/ ou fix/ selon le type de changement. Ouvre une PR par unité de travail logique une fois les commits poussés."
metadata: {"openclaw":{"emoji":"🌿","requires":{"bins":["git","curl","jq"],"env":["FORGEJO_TOKEN","FORGEJO_URL","REPO","ISSUE_ID","PARENT_BRANCH"]}}}
user-invocable: false
---

# git-flow — Git flow propre

## Règles absolues

- **Un commit par changement logique** — jamais un gros commit fourre-tout
- **Une branche par unité de travail** — feature, fix, refactor, test, docs
- **Une PR par branche** — jamais de PR multi-sujets
- **Tu ne merges JAMAIS toi-même** — ouvre la PR, c'est tout
- **Messages de commit conventionnels** : `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`

## Structure des branches

```
${PARENT_BRANCH}                    ← branche principale de l'issue (agent/issue-N-slug)
  ├── feat/${ISSUE_ID}-nom-court    ← nouvelle fonctionnalité
  ├── fix/${ISSUE_ID}-nom-court     ← correction de bug
  ├── refactor/${ISSUE_ID}-nom      ← refactoring sans changement fonctionnel
  ├── test/${ISSUE_ID}-nom          ← ajout/correction de tests
  └── docs/${ISSUE_ID}-nom          ← documentation uniquement
```

## Workflow par unité de travail

### 1. Identifier le type de changement

Avant de toucher au code, détermine :
- `feat` : nouvelle fonctionnalité, nouveau comportement
- `fix` : correction d'un bug, comportement cassé
- `refactor` : amélioration sans changement fonctionnel
- `test` : ajout ou correction de tests
- `docs` : documentation, commentaires, README

### 2. Créer la branche de travail

```bash
WORK_TYPE="feat"        # feat | fix | refactor | test | docs
WORK_SLUG="nom-court"   # 2-4 mots kebab-case décrivant le changement
WORK_BRANCH="${WORK_TYPE}/${ISSUE_ID}-${WORK_SLUG}"

# Partir de la branche principale de l'issue
git checkout "${PARENT_BRANCH}" 2>/dev/null || git checkout main
git checkout -b "${WORK_BRANCH}"
```

### 3. Coder et committer atomiquement

**Après CHAQUE changement logique** (un fichier, un composant, une fonction) :

```bash
# Stagier UNIQUEMENT les fichiers de ce changement
git add chemin/vers/fichier.ext

# Message conventionnel
git commit -m "feat(auth): ajouter la validation JWT dans le middleware

- Vérifie l'expiration du token
- Extrait le userId depuis le payload
- Retourne 401 si invalide

Refs #${ISSUE_ID}"
```

**Ne jamais faire** `git add .` sauf si tous les fichiers modifiés font partie du même changement atomique.

### 4. Pousser et ouvrir la PR

```bash
git push origin "${WORK_BRANCH}"

# Créer la PR vers la branche principale de l'issue (pas vers main)
curl -sf -X POST \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  -H "Content-Type: application/json" \
  "${FORGEJO_URL}/api/v1/repos/${REPO}/pulls" \
  -d "$(jq -n \
    --arg title "${WORK_TYPE}(${WORK_SLUG}): description courte" \
    --arg body  "## Changements\n\n- Description du changement\n\n## Pourquoi\n\nRéfère à l'issue #${ISSUE_ID}\n\nPart of #${ISSUE_ID}" \
    --arg head  "${WORK_BRANCH}" \
    --arg base  "${PARENT_BRANCH}" \
    '{title: $title, body: $body, head: $head, base: $base}'
  )"
```

### 5. Revenir sur la branche principale pour la suite

```bash
git checkout "${PARENT_BRANCH}"
```

## Gestion des review comments

Si une PR reçoit des review comments :

```bash
# Récupérer les comments de review
PR_REVIEWS=$(curl -sf \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  "${FORGEJO_URL}/api/v1/repos/${REPO}/pulls/${PR_NUMBER}/reviews")

# Reprendre sur la même branche
git checkout "${WORK_BRANCH}"
git pull origin "${WORK_BRANCH}"

# Corriger, committer
git add fichier-corrigé.ext
git commit -m "fix(review): corriger X selon review de @reviewer

${DETAIL_DU_FIX}

Addresses review on #${PR_NUMBER}"

git push origin "${WORK_BRANCH}"
```

## Ce que tu fais en fin d'issue

Une fois toutes les PR de travail ouvertes :

```bash
# PR principale de l'issue — agrège les branches de travail
curl -sf -X POST \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  -H "Content-Type: application/json" \
  "${FORGEJO_URL}/api/v1/repos/${REPO}/pulls" \
  -d "$(jq -n \
    --arg title "Issue #${ISSUE_ID}: ${ISSUE_TITLE}" \
    --arg body  "Closes #${ISSUE_ID}\n\n## Résumé\n\n${SUMMARY}\n\n## PRs de travail\n\n${PR_LIST}" \
    --arg head  "${PARENT_BRANCH}" \
    --arg base  "main" \
    '{title: $title, body: $body, head: $head, base: $base}'
  )"
```

## Exemple concret

Issue #42 : "Ajouter l'authentification JWT"

```
main
 └── agent/issue-42-add-jwt-auth         ← PR principale → main
       ├── feat/42-jwt-validation         ← PR atomique : middleware JWT
       ├── feat/42-refresh-token          ← PR atomique : refresh token
       ├── test/42-jwt-unit-tests         ← PR atomique : tests unitaires
       └── docs/42-auth-api-docs          ← PR atomique : documentation API
```

Chaque PR atomique est ouverte vers `agent/issue-42-add-jwt-auth`.
La PR principale est ouverte vers `main` avec `Closes #42`.
