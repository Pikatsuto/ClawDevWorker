---
name: spec-init
description: "Initializes an empty project via BMAD (PRD → Architecture → User Stories), commits the spec on main, then automatically creates Forgejo/GitHub issues with acceptance criteria. Webhooks trigger the RBAC pipeline on each issue. This is the /spec of clawdevworker."
metadata: {"openclaw":{"emoji":"📐","requires":{"bins":["git","node","curl","jq"]}}}
user-invocable: true
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# spec-init — From empty repo to autonomous pipeline

## Full flow

```
/spec init owner/repo "Project name"
  ↓
Clone empty repo into ephemeral container
  ↓
Interactive BMAD (or doc mode if context provided)
  → PRD.md          — vision, objectives, personas, KPIs
  → ARCHITECTURE.md — stack, components, technical decisions
  → USER_STORIES.md — stories with acceptance criteria
  ↓
Commit on main: "chore: initialize project spec via BMAD"
  ↓
For each user story:
  → Create a Forgejo/GitHub issue with title + acceptance criteria
  → Assign to the agent account ($AGENT_GIT_LOGIN)
  ↓
Webhook triggered → autonomous RBAC pipeline starts
```

## Commands

| Command | Action |
|---------|--------|
| `/spec init <owner/repo>` | Launch BMAD in interactive mode |
| `/spec init <owner/repo> --from <brief.md>` | BMAD from an existing brief |
| `/spec status <owner/repo>` | View created issues and their status |
| `/spec add-story <owner/repo> "title"` | Add a story after init |

## Procedure /spec init

### 1. Clone the repo

```bash
REPO="${1}"            # owner/repo
PROJECT_NAME="${2}"    # "Project name"
PROVIDER_URL="${GIT_PROVIDER_1_URL:-http://host-gateway:3000}"
TOKEN="${GIT_PROVIDER_1_TOKEN:-$FORGEJO_TOKEN}"

CLONE_DIR="/tmp/spec-${REPO//\//_}"
git clone "${PROVIDER_URL}/${REPO}.git" "$CLONE_DIR" 2>/dev/null \
  || { echo "❌ Unable to clone ${REPO}"; exit 1; }

cd "$CLONE_DIR"
git config user.email "agent@coderclaw.local"
git config user.name "CoderClaw Agent"
```

### 2. Generate the spec via BMAD

If BMAD is available in headless mode:

```bash
# Headless mode with provided brief
if [ -n "$BRIEF_FILE" ] && [ -f "$BRIEF_FILE" ]; then
  # BMAD reads the brief and generates the spec without interaction
  openclaw run --skill bmad-spec \
    --input "$BRIEF_FILE" \
    --output-dir "$CLONE_DIR/docs/spec" \
    --model "$MODEL_CPU"
else
  # Interactive mode — the agent dialogues with the human to build the spec
  cat << 'SPEC_PROMPT'
I will guide you to create the complete spec for your project.

Answer these questions one by one:

1. **Vision**: In one sentence, what is this project?
2. **Users**: Who uses it? (personas)
3. **Problem solved**: What pain does it relieve?
4. **Key features**: List the 3-5 essential features
5. **Tech stack**: Which languages/frameworks?
6. **Success criteria**: How do we know it's successful?

I will then generate PRD.md, ARCHITECTURE.md and USER_STORIES.md.
SPEC_PROMPT
fi
```

### 3. Generated file structure

```
docs/spec/
├── PRD.md              ← Product Requirements Document
├── ARCHITECTURE.md     ← Technical decisions and stack
└── USER_STORIES.md     ← Stories with acceptance criteria
.coderclaw/
├── rules.yaml          ← RBAC pipeline (copied from template)
└── context.yaml        ← Project metadata
```

### 4. Commit and push

```bash
mkdir -p docs/spec .coderclaw

# Copy the rules.yaml template
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
echo "✓ Spec committed on main"
```

### 5. Create issues from USER_STORIES.md

```javascript
// create-issues.js — parse USER_STORIES.md and create issues
const fs   = require('fs');
const http = require('http');
const https = require('https');

const PROVIDER_URL = process.env.GIT_PROVIDER_1_URL || 'http://host-gateway:3000';
const TOKEN        = process.env.GIT_PROVIDER_1_TOKEN || process.env.FORGEJO_TOKEN;
const REPO         = process.env.REPO;
const AGENT_LOGIN  = process.env.AGENT_GIT_LOGIN || 'agent';
const STORIES_FILE = process.env.STORIES_FILE || 'docs/spec/USER_STORIES.md';

const content = fs.readFileSync(STORIES_FILE, 'utf8');

// Parse stories — expected format:
// ## US-001 — Story title
// **As a** ...
// **I want** ...
// **So that** ...
//
// ### Acceptance criteria
// - [ ] criterion 1
// - [ ] criterion 2

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
  console.log('⚠️ No user stories found in USER_STORIES.md');
  console.log('Expected format: ## US-001 — Title');
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
      body:    story.body + '\n\n---\n*Automatically generated by /spec init*',
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
          console.log(`✓ Issue #${r.number} created: ${story.title}`);
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
  console.log(`\n=== Creating ${stories.length} issues on ${REPO} ===\n`);
  for (const story of stories) {
    try {
      await createIssue(story);
      await new Promise(r => setTimeout(r, 500)); // rate limit
    } catch(e) {
      console.error(`❌ Error: ${story.title} — ${e.message}`);
    }
  }
  console.log('\n✅ Issues created. The RBAC pipeline will start automatically via webhook.');
})();
```

```bash
# Launch issue creation
STORIES_FILE="$CLONE_DIR/docs/spec/USER_STORIES.md" \
REPO="$REPO" \
  node /opt/skills/spec-init/create-issues.js
```

## USER_STORIES.md template

```markdown
# User Stories — {PROJECT NAME}

## US-001 — User authentication

**As a** non-logged-in visitor
**I want** to be able to create an account and log in
**So that** I can access protected features

### Acceptance criteria

- [ ] Registration form with email + password
- [ ] Mandatory email validation
- [ ] Login with JWT (expiry 24h)
- [ ] Password reset page
- [ ] Private route protection (redirect if not logged in)

## US-002 — ...
```
