# docker-exec

Exécute du code dans un container Docker éphémère isolé.

## Comportement

- Le container est lancé avec `docker run --rm` — détruit automatiquement après exécution
- Réseau : `none` par défaut — aucun accès internet, aucun accès aux services internes
- Le code est passé via stdin ou un fichier temporaire monté en volume
- stdout et stderr sont retournés à l'agent
- Si le container dépasse le timeout, il est tué (`docker kill`)

## Images disponibles (pré-pullées)

- `python:3.12-slim` — Python 3.12
- `node:22-slim` — Node.js 22
- `ubuntu:24.04` — Bash, outils GNU standard
- `bash:5` — Bash ultra-léger

## Utilisation

```
Écrire et exécuter un script Python :
1. Créer le fichier /tmp/script.py avec le contenu voulu
2. Appeler docker-exec avec image=python:3.12-slim, file=/tmp/script.py

Exécuter une commande Bash :
1. Appeler docker-exec avec image=bash:5, command="echo hello"
```

## Sécurité

- `--network none` — pas d'accès réseau
- `--read-only` — filesystem en lecture seule sauf /tmp
- `--memory ${EPHEMERAL_MEMORY}` — limite RAM
- `--cpus ${EPHEMERAL_CPUS}` — limite CPU
- Timeout : `${EPHEMERAL_TIMEOUT}s`
- Pas d'accès au socket Docker de l'hôte (DinD rootless interne)
