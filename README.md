# ClawDevWorker v14

Stack autonome de développement multi-agent : Code Server éphémère + Ollama + agents OpenClaw spécialistes sur GPU local.

Les agents reçoivent des issues Forgejo ou GitHub, les analysent, codent, reviewent en pipeline RBAC, et ouvrent des PRs — sans intervention humaine. L'humain garde le contrôle via le chat et les sessions Code Server interactives.

---

## Architecture

```
Internet
 └── chat.example.com          → Traefik → openclaw-chat
 └── dev-<id>.DEV_DOMAIN       → Traefik → container Code Server éphémère
 └── ssh.dev-<id>.DEV_DOMAIN   → Traefik → sshd du container (si /ssh-key configurée)
```

### Sessions dev — éphémère vs persistant

```
ÉPHÉMÈRE (--rm, détruit à /dev release ou idle 30min) :
  Paquets système, node_modules, build artifacts

PERSISTANT (volumes par user) :
  Profil VSCode (settings, keybindings)
  Extensions installées
  Config OpenClaw + clé SSH

PERSISTANT (git) :
  Code → Forgejo / GitHub
  Environnement → .devcontainer/devcontainer.json dans le repo

PERSISTANT (volume project_data partagé) :
  Mémoire sémantique par projet (SQLite)
  Session handoffs
  Index codebase incrémental
```

### GPU scheduler — 3 modes de cohabitation

```
AGENT_ACTIVE     → agents autonomes libres, toute la VRAM disponible
HUMAN_SHARED     → session dev active, agents continuent si VRAM ≥ 2GB libre
HUMAN_EXCLUSIVE  → VRAM pleine, agents mis en pause (queue)
```

Upgrade/downgrade de modèle :
- **Chat / Code Server** — proposition affichée dans la session, `/upgrade` ou `/downgrade` pour confirmer
- **Worker autonome** — upgrade/downgrade silencieux selon score de complexité

### 12 agents spécialistes

**Techniques :** `architect` `frontend` `backend` `fullstack` `devops` `security` `qa` `doc`

**Métier :** `marketing` `design` `product` `bizdev`

Chaque spécialiste a son system prompt dédié. Le CPU analyse l'issue et détermine les spécialistes nécessaires. Les labels Forgejo/GitHub servent d'override manuel.

### Pipeline RBAC configurable par projet

```yaml
# .coderclaw/rules.yaml dans chaque repo
pipeline:
  gates: [architect, fullstack, security, qa, doc]
  require_all: true
  max_retries: 3
  retry_upgrade: true
```

Gates non listés = ignorés. `require_all: false` = gates en parallèle sans blocage.

### DAG de dépendances entre issues

```markdown
## US-003 — Dashboard
**Dépend de :** US-001, US-002
```

L'orchestrateur attend que US-001 et US-002 soient `Done` avant de démarrer US-003.

### Modèle cerveau humain

```
Amygdala    → loop-detect + handleGateFail + escalateToHuman
Hippocampus → semantic-memory + session-handoff + codebase-index incrémental
Cortex      → orchestrateur + GPU scheduler + routing 12 spécialistes + DAG + RBAC
```

---

## Commandes principales

### Sessions dev

```
/dev create owner/repo              → Code Server éphémère avec repo cloné
/dev create owner/repo --password   → avec authentification
/dev release                        → ferme la session
/dev status                         → sessions actives et URLs
```

Si `/ssh-key` configurée, chaque session expose aussi un accès SSH compatible VS Code Desktop, Cursor, Windsurf et JetBrains Gateway.

### Clé SSH (accès IDE natif)

```
/ssh-key set <clef_publique>        → sauvegarde pour toutes les sessions
/ssh-key status                     → vérifie si configurée
/ssh-key clear                      → supprime
```

### Initialisation projet

```
/spec init owner/repo               → BMAD → PRD + Architecture + User Stories → issues Forgejo
/spec status owner/repo             → état du pipeline
```

### Token git utilisateur

```
/token set <token>                  → token personnel (pour créer repos sur son compte)
/token status
/token clear
```

### Contexte projet

```
/project select <nom>               → charge mémoire + handoff + rules
/project status                     → issues et PRs en cours
/project code                       → code en lecture seule
/project list                       → liste les projets
```

### Session handoff

```
/handoff                            → sauvegarde état complet de la session
/resume latest                      → reprend la dernière session
/resume <id>                        → reprend une session spécifique
```

### Mémoire sémantique

```
/remember <query>                   → recherche dans la mémoire du projet
/learn <fait>                       → mémorise une décision
/memory list                        → entrées récentes
```

### Codebase

```
/analyze                            → mise à jour index incrémental (git-diff)
/analyze --full                     → scan complet forcé
/search <query>                     → recherche dans l'index
/impact <fichier>                   → impact radius avant modification
```

### Staged diff (sessions interactives)

```
/diff                               → affiche les changements en attente
/diff src/auth.ts                   → diff d'un fichier
/accept                             → commit atomique de tous les changements
/accept src/auth.ts                 → commit d'un fichier
/reject                             → annule tous les changements
```

### GPU

```
/gpu status                         → VRAM libre, mode, slots actifs
/gpu models                         → modèles disponibles
```

---

## Devcontainer.json

Ajouter `.devcontainer/devcontainer.json` dans le repo pour personnaliser l'environnement :

```json
{
  "name": "Mon projet",
  "postCreateCommand": "npm install",
  "containerEnv": { "NODE_ENV": "development" },
  "forwardPorts": [3000, 5173]
}
```

`postCreateCommand` s'exécute une seule fois par version du fichier. Modifier + commiter → re-exécuté à la prochaine session.

---

## Services

| Service | Image | Rôle |
|---------|-------|------|
| `ollama` | `ollama/ollama:latest` | GPU (RTX 2080 Ti + GTX 1660) |
| `ollama-cpu` | `ollama/ollama:latest` | CPU orchestration |
| `ollama-init` | `cdw-ollama-init:latest` | Téléchargement modèles (éphémère) |
| `openclaw-agent` | `cdw-agent:latest` | Scheduler + orchestrateur + webhooks |
| `openclaw-chat` | `cdw-chat:latest` | Interface chat + commandes |
| `devcontainer` | `cdw-devcontainer:latest` | Sessions Code Server (spawné dynamiquement) |
| `devdocs` | `freecodecamp/devdocs` | Documentation offline |
| `searxng` | `cdw-searxng:latest` | Moteur de recherche local |
| `browserless` | `cdw-browserless:latest` | Browser headless |
| `mcp-docs` | `cdw-mcp-docs:latest` | MCP server documentation |
| `cdw-squid` | `cdw-squid:latest` | Proxy sortant agents |

---

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `CHAT_DOMAIN` | — | Domaine openclaw-chat |
| `DEV_DOMAIN` | — | Domaine wildcard sessions dev (`*.DEV_DOMAIN`) |
| `OPENCLAW_GATEWAY_PASSWORD` | — | Mot de passe chat |
| `GIT_PROVIDER_1` | `forgejo` | Type provider 1 |
| `GIT_PROVIDER_1_URL` | — | URL Forgejo |
| `GIT_PROVIDER_1_TOKEN` | — | Token compte agent |
| `GIT_PROVIDER_2` | — | `github` si GitHub App activé |
| `GIT_PROVIDER_2_APP_ID` | — | GitHub App ID |
| `GIT_PROVIDER_2_PRIVATE_KEY_B64` | — | Clé privée GitHub App (base64) |
| `AGENT_GIT_LOGIN` | `agent` | Login compte agent git |
| `MODEL_COMPLEX` | `qwen3.5:27b-q3_k_m` | Score ≥ 70 |
| `MODEL_STANDARD` | `qwen3.5:9b` | Score 30–70 |
| `MODEL_LIGHT` | `qwen3.5:4b` | Score 10–30 |
| `MODEL_TRIVIAL` | `qwen3.5:2b` | Score < 10 |
| `MODEL_CPU` | `qwen3.5:0.8b` | CPU orchestration |
| `MODEL_<ROLE>` | — | Override par rôle (ex: `MODEL_MARKETING=mistral:7b`) |
| `DEVCONTAINER_IMAGE` | `cdw-devcontainer:latest` | Image sessions dev |
| `DEVCONTAINER_MEMORY` | `4g` | RAM par session |
| `DEVCONTAINER_CPUS` | `2.0` | CPUs par session |
| `DEV_IDLE_MS` | `1800000` | Timeout inactivité (30min) |
| `DEV_NETWORK` | `coolify` | Réseau Docker pour Traefik |
| `GATE_MAX_RETRIES` | `3` | Retries avant escalade humaine |
| `LOOP_DETECT_THRESHOLD` | `2` | Hash répété → boucle détectée |
| `UPGRADE_THRESHOLD` | `30` | Score delta avant proposition upgrade |
| `DOWNGRADE_STREAK_MAX` | `3` | Messages bas de suite avant downgrade |

---

## Checklist déploiement

- [ ] DNS wildcard `*.DEV_DOMAIN` → IP serveur
- [ ] Traefik configuré pour wildcard TLS
- [ ] `.env` rempli depuis `.env.example`
- [ ] `docker compose up -d`
- [ ] `docker compose logs ollama-init` → modèles téléchargés
- [ ] DevDocs : `docker compose exec devdocs thor docs:download javascript`
- [ ] Webhook Forgejo → `http://openclaw-agent:9000/webhook`
- [ ] Branch protection sur `main` (Required approvals: 1)
- [ ] `.coderclaw/rules.yaml` dans chaque repo cible

---

## Compatibilité IDE

| Accès | Condition | Compatible |
|-------|-----------|------------|
| Navigateur (Code Server) | toujours | tous navigateurs |
| VS Code Desktop | `/ssh-key` configurée | Remote-SSH |
| Cursor | `/ssh-key` configurée | Remote-SSH |
| Windsurf | `/ssh-key` configurée | Remote-SSH |
| JetBrains Gateway | `/ssh-key` configurée | SSH natif |
