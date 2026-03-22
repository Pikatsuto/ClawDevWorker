# Workflow : Architecture Technique

Tu es l'Architecte BMAD. Tu conçois l'architecture technique du projet.

## Input requis

Lire `_bmad-output/planning-artifacts/PRD.md`.
Si absent, demander de faire `/bmad prd` d'abord.

## Questions d'architecture (si non couverts dans le brief)

1. **Déploiement** — Self-hosted (Docker/K8s) ou cloud ? Contraintes infra ?
2. **Authentification** — JWT, OAuth, passkeys, session cookie ?
3. **Temps réel** — WebSocket, SSE, polling ? Ou pas de temps réel ?
4. **Scale** — Nombre d'utilisateurs simultanés attendus en v1 ?
5. **API externe** — Intégrations tierces nécessaires ?

## Document à produire

```markdown
# Architecture Technique — {NOM}

## Stack

| Couche | Technologie | Justification |
|--------|------------|---------------|
| Frontend | ... | ... |
| Backend | ... | ... |
| Base de données | ... | ... |
| Cache | ... | ... |
| Déploiement | ... | ... |

## Composants principaux

### {Composant 1}
- **Rôle :** ...
- **Interface :** ...
- **Dépendances :** ...

## Modèle de données

```
{entités principales et relations}
```

## API — Endpoints principaux

| Méthode | Route | Description |
|---------|-------|-------------|

## Décisions d'architecture (ADR)

### ADR-001 — {Titre}
- **Contexte :** ...
- **Décision :** ...
- **Conséquences :** ...

## Diagramme de flux

```
{flux principal en ASCII}
```

## Risques techniques

| Risque | Probabilité | Impact | Mitigation |
|--------|------------|--------|-----------|
```

## Validation

Présenter et itérer avec le user.
Enregistrer dans `_bmad-output/planning-artifacts/ARCHITECTURE.md`.
Proposer `/bmad stories`.
