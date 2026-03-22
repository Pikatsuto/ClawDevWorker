---
name: bmad
description: "BMAD Method (Breakthrough Method of Agile AI Driven Development). Orchestre la génération complète de spec projet : brief produit → PRD → architecture → epics et user stories avec dépendances. Utilisé par /spec init pour initialiser un projet avant de créer les issues Forgejo. Deux modes : interactif (dialogue avec le user) ou batch (depuis un brief.md existant)."
metadata: {"openclaw":{"emoji":"📋"}}
user-invocable: true
always: false
---

# BMAD Method — Spec projet structurée

## Commandes disponibles

| Commande | Action |
|----------|--------|
| `/bmad brief` | Démarre le brief produit interactif |
| `/bmad prd` | Génère le PRD depuis le brief |
| `/bmad arch` | Génère l'architecture technique |
| `/bmad stories` | Génère les epics et user stories avec dépendances |
| `/bmad full` | Enchaîne les 4 phases en mode interactif |
| `/bmad batch <brief.md>` | Mode batch depuis un fichier brief existant |
| `/bmad status` | État du workflow en cours |

## Utilisation dans /spec init

`/spec init` appelle BMAD automatiquement. Tu n'as pas besoin d'appeler `/bmad` manuellement sauf pour travailler la spec sans créer de projet.

## Format USER_STORIES.md attendu par create-issues.js

Chaque story DOIT suivre ce format pour que les issues et le DAG soient générés correctement :

```markdown
## US-001 — Titre de la story

**En tant que** [persona]
**Je veux** [action]
**Afin de** [bénéfice]

**Dépend de :** US-002, US-003
*(omettre cette ligne si pas de dépendances)*

### Critères d'acceptance

- [ ] critère 1
- [ ] critère 2
- [ ] critère 3
```

## Procédure mode interactif (/bmad full)

Charge le workflow depuis `/opt/skills/bmad/workflows/` et guide le user phase par phase.

```bash
WORKFLOWS_DIR="/opt/skills/bmad/workflows"
OUTPUT_DIR="${PROJECT_DIR:-/workspace}/_bmad-output"
mkdir -p "$OUTPUT_DIR/planning-artifacts"

# Phase 1 : Brief produit
cat "$WORKFLOWS_DIR/product-brief.md"
# → dialogue interactif avec le user
# → génère : $OUTPUT_DIR/planning-artifacts/product-brief.md

# Phase 2 : PRD
cat "$WORKFLOWS_DIR/create-prd.md"
# → génère : $OUTPUT_DIR/planning-artifacts/PRD.md

# Phase 3 : Architecture
cat "$WORKFLOWS_DIR/create-architecture.md"
# → génère : $OUTPUT_DIR/planning-artifacts/ARCHITECTURE.md

# Phase 4 : Stories
cat "$WORKFLOWS_DIR/create-epics-and-stories.md"
# → génère : $OUTPUT_DIR/planning-artifacts/USER_STORIES.md
#   IMPORTANT : inclure les dépendances "**Dépend de :** US-NNN"
```

## Procédure mode batch (/bmad batch <brief.md>)

```bash
BRIEF_FILE="$1"
# Lire le brief et générer PRD + ARCHITECTURE + USER_STORIES en une passe
# en mode autonome sans interaction utilisateur
# Utiliser le modèle complexe pour la qualité de la génération
```
