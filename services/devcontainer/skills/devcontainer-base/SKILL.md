---
name: devcontainer
description: "Gère les sessions de développement éphémères Code Server. Utilise /dev create pour démarrer une session VSCode dans le navigateur, /dev release pour la fermer, /dev status pour voir l'état. Le container est éphémère (--rm) mais le profil VSCode, les extensions et la config OpenClaw persistent dans des volumes par user entre les sessions."
metadata: {"openclaw":{"emoji":"🖥️"}}
user-invocable: true
---

# devcontainer — Sessions dev éphémères Code Server

## Principe

Chaque session est un container Docker éphémère avec Code Server + OpenClaw.
Éphémère = destroyed à `/dev release` ou après 30min d'inactivité.
Persistant = profil VSCode, extensions, config OpenClaw (volumes par user).

## Commandes

| Commande | Action |
|----------|--------|
| `/dev create` | Démarre une session dev (workspace vide) |
| `/dev create owner/repo` | Démarre avec un repo Forgejo cloné |
| `/dev create owner/repo --password monpass` | Avec mot de passe |
| `/dev release` | Ferme la session (auto-commit des changements) |
| `/dev status` | Sessions actives et URL |
| `/dev queue` | Position dans la queue si VRAM occupée |

## Procédure /dev create

```bash
# L'agent appelle l'orchestrateur
curl -sf -X POST http://localhost:9001/dev/create \
  -H "Content-Type: application/json" \
  -d '{
    "userId":   "'$USER_ID'",
    "repo":     "'"${REPO:-}"'",
    "password": "'"${DEV_PASSWORD:-}"'"
  }'
```

L'orchestrateur :
1. Vérifie qu'il n'y a pas de session active pour cet user
2. Vérifie la disponibilité VRAM
3. Spawn le container avec labels Traefik pour l'URL éphémère
4. Signale au scheduler : HUMAN_SHARED (agents continuent si VRAM dispo)
5. Retourne l'URL : `https://dev-abc123.exemple.com`

## Ce qui est éphémère vs persistant

```
ÉPHÉMÈRE (container --rm) :
  - Tous les paquets système installés dans la session
  - node_modules, pip packages, build artifacts
  - Fichiers hors /workspace et hors volumes

PERSISTANT (volumes Docker par user) :
  - ~/.config/Code/User/          ← settings, keybindings
  - ~/.local/share/code-server/   ← extensions installées
  - ~/.openclaw/                  ← config gateway, mémoire

PERSISTANT (git) :
  - Le code → committé sur Forgejo
  - L'environnement → .devcontainer/devcontainer.json dans le repo
```

## Devcontainer.json — modifier l'environnement entre sessions

```json
// .devcontainer/devcontainer.json dans le repo
{
  "name": "Mon projet",
  "postCreateCommand": "npm install && pip install -r requirements.txt",
  "containerEnv": {
    "NODE_ENV": "development",
    "DATABASE_URL": "postgresql://localhost/mydb"
  },
  "forwardPorts": [3000, 8000]
}
```

La commande `postCreateCommand` n'est exécutée qu'une fois par version du devcontainer.json.
Si tu modifies le fichier et commites, elle sera re-exécutée à la prochaine session.

## Heartbeat — éviter l'idle timeout

Code Server envoie automatiquement des heartbeats toutes les 5min à l'orchestrateur.
Si aucune activité depuis 30min → container arrêté, changements auto-commités.

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `DEVCONTAINER_IMAGE` | `ghcr.io/pikatsuto/cdw-devcontainer:latest` | Image de base |
| `DEVCONTAINER_MEMORY` | `4g` | RAM par session |
| `DEVCONTAINER_CPUS` | `2.0` | CPU par session |
| `DEV_DOMAIN` | `dev.exemple.com` | Domaine des URLs éphémères |
| `DEV_IDLE_MS` | `1800000` | Timeout idle (30min) |
