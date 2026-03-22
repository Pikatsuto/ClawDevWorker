---
name: spec-init
description: "Initialise un projet vide via BMAD (PRD → Architecture → User Stories), committe la spec sur main, puis crée automatiquement les issues Forgejo/GitHub avec critères d'acceptance. Les webhooks déclenchent le pipeline RBAC sur chaque issue. C'est le /spec de clawdevworker."
metadata: {"openclaw":{"emoji":"📐","requires":{"bins":["git","node","curl","jq"]}}}
user-invocable: true
---

# spec-init — Du repo vide au pipeline autonome

## Flow complet

```
/spec init owner/repo "Nom du projet"
  ↓
Clone repo vide dans container éphémère
  ↓
BMAD interactive (ou mode doc si context fourni)
  → PRD.md          — vision, objectifs, personas, KPIs
  → ARCHITECTURE.md — stack, composants, décisions techniques
  → USER_STORIES.md — stories avec critères d'acceptance
  ↓
Commit sur main : "chore: initialize project spec via BMAD"
  ↓
Pour chaque user story :
  → Créé une issue Forgejo/GitHub avec titre + critères d'acceptance
  → Assigne au compte agent ($AGENT_GIT_LOGIN)
  ↓
Webhook déclenché → pipeline RBAC autonome démarre
```

## Commandes

| Commande | Action |
|----------|--------|
| `/spec init <owner/repo>` | Lance BMAD en mode interactif |
| `/spec init <owner/repo> --from <brief.md>` | BMAD depuis un brief existant |
| `/spec status <owner/repo>` | Voir les issues créées et leur état |
| `/spec add-story <owner/repo> "titre"` | Ajouter une story après init |

## Procédure /spec init

### 1. Cloner le repo

```bash
REPO="${1}"            # owner/repo
PROJECT_NAME="${2}"    # "Nom du projet"
PROVIDER_URL="${GIT_PROVIDER_1_URL:-http://host-gateway:3000}"
TOKEN="${GIT_PROVIDER_1_TOKEN:-$FORGEJO_TOKEN}"

CLONE_DIR="/tmp/spec-${REPO//\//_}"
git clone "${PROVIDER_URL}/${REPO}.git" "$CLONE_DIR" 2>/dev/null \
  || { echo "❌ Impossible de cloner ${REPO}"; exit 1; }

cd "$CLONE_DIR"
git config user.email "agent@coderclaw.local"
git config user.name "CoderClaw Agent"
```

### 2. Générer la spec via BMAD

Si BMAD est disponible en headless :

```bash
# Mode headless avec brief fourni
if [ -n "$BRIEF_FILE" ] && [ -f "$BRIEF_FILE" ]; then
  # BMAD lit le brief et génère la spec sans interaction
  openclaw run --skill bmad-spec \
    --input "$BRIEF_FILE" \
    --output-dir "$CLONE_DIR/docs/spec" \
    --model "$MODEL_CPU"
else
  # Mode interactif — l'agent dialogue avec l'humain pour construire la spec
  cat << 'SPEC_PROMPT'
Je vais te guider pour créer la spec complète de ton projet.

Réponds à ces questions une par une :

1. **Vision** : En une phrase, c'est quoi ce projet ?
2. **Utilisateurs** : Qui l'utilise ? (personas)
3. **Problème résolu** : Quel douleur ça soulage ?
4. **Fonctionnalités clés** : Liste les 3-5 features essentielles
5. **Stack technique** : Quels langages/frameworks ?
6. **Critères de succès** : Comment on sait que c'est réussi ?

Je génèrerai ensuite PRD.md, ARCHITECTURE.md et USER_STORIES.md.
SPEC_PROMPT
fi
```

### 3. Structure de fichiers générée

```
docs/spec/
├── PRD.md              ← Product Requirements Document
├── ARCHITECTURE.md     ← Décisions techniques et stack
└── USER_STORIES.md     ← Stories avec critères d'acceptance
.coderclaw/
├── rules.yaml          ← Pipeline RBAC (copié depuis template)
└── context.yaml        ← Métadonnées projet
```

### 4. Commit et push

```bash
mkdir -p docs/spec .coderclaw

# Copier le template rules.yaml
cp /opt/skills/spec-init/templates/rules.yaml .coderclaw/rules.yaml

# context.yaml
cat > .coderclaw/context.yaml << YAML
name: "$PROJECT_NAME"
repo: "$REPO"
created: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
description: ""
YAML

git add docs/spec/ .coderclaw/
git commit -m "chore: initialize project spec via BMAD"
git push origin main
echo "✓ Spec committée sur main"
```

### 5. Créer les issues depuis USER_STORIES.md

```javascript
// create-issues.js — parse USER_STORIES.md et crée les issues
const fs   = require('fs');
const http = require('http');
const https = require('https');

const PROVIDER_URL = process.env.GIT_PROVIDER_1_URL || 'http://host-gateway:3000';
const TOKEN        = process.env.GIT_PROVIDER_1_TOKEN || process.env.FORGEJO_TOKEN;
const REPO         = process.env.REPO;
const AGENT_LOGIN  = process.env.AGENT_GIT_LOGIN || 'agent';
const STORIES_FILE = process.env.STORIES_FILE || 'docs/spec/USER_STORIES.md';

const content = fs.readFileSync(STORIES_FILE, 'utf8');

// Parse les stories — format attendu :
// ## US-001 — Titre de la story
// **En tant que** ...
// **Je veux** ...
// **Afin de** ...
//
// ### Critères d'acceptance
// - [ ] critère 1
// - [ ] critère 2

const storyRe = /^## (US-\d+[^#\n]*)\n([\s\S]*?)(?=^## US-|\Z)/gm;
const stories = [];
let m;
while ((m = storyRe.exec(content)) !== null) {
  stories.push({
    title: m[1].trim(),
    body:  m[2].trim(),
  });
}

if (!stories.length) {
  console.log('⚠️ Aucune user story trouvée dans USER_STORIES.md');
  console.log('Format attendu : ## US-001 — Titre');
  process.exit(0);
}

const [owner, repoName] = REPO.split('/');
const isHttps = PROVIDER_URL.startsWith('https');
const lib = isHttps ? https : http;
const base = new URL(PROVIDER_URL);

async function createIssue(story) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      title:   story.title,
      body:    story.body + '\n\n---\n*Générée automatiquement par /spec init*',
      assignees: [AGENT_LOGIN],
    });
    const opts = {
      method:   'POST',
      hostname: base.hostname,
      port:     base.port || (isHttps ? 443 : 80),
      path:     `/api/v1/repos/${owner}/${repoName}/issues`,
      headers: {
        'Authorization': `token ${TOKEN}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = lib.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          console.log(`✓ Issue #${r.number} créée : ${story.title}`);
          resolve(r);
        } catch { reject(new Error(d)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log(`\n=== Création de ${stories.length} issues sur ${REPO} ===\n`);
  for (const story of stories) {
    try {
      await createIssue(story);
      await new Promise(r => setTimeout(r, 500)); // rate limit
    } catch(e) {
      console.error(`❌ Erreur : ${story.title} — ${e.message}`);
    }
  }
  console.log('\n✅ Issues créées. Le pipeline RBAC va démarrer automatiquement via webhook.');
})();
```

```bash
# Lancer la création des issues
STORIES_FILE="$CLONE_DIR/docs/spec/USER_STORIES.md" \
REPO="$REPO" \
  node /opt/skills/spec-init/create-issues.js
```

## Template USER_STORIES.md

```markdown
# User Stories — {NOM DU PROJET}

## US-001 — Authentification utilisateur

**En tant que** visiteur non connecté
**Je veux** pouvoir créer un compte et me connecter
**Afin de** accéder aux fonctionnalités protégées

### Critères d'acceptance

- [ ] Formulaire d'inscription avec email + mot de passe
- [ ] Validation email obligatoire
- [ ] Connexion avec JWT (expiry 24h)
- [ ] Page de réinitialisation de mot de passe
- [ ] Protection des routes privées (redirect si non connecté)

## US-002 — ...
```
