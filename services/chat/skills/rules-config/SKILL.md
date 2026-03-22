---
name: rules-config
description: "Interactive configuration of .coderclaw/rules.yaml for a project. Asks the user about their project type, tech stack, and quality requirements to generate customized pipeline gates and specialist triggers. Can be run standalone via /rules or automatically as part of /spec init."
metadata: {"openclaw":{"emoji":"⚙️"}}
user-invocable: true
trigger: "/rules"
always: false
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# rules-config — Interactive pipeline configuration

## When this runs

- **Standalone**: User types `/rules` to configure rules for any project
- **During /spec init**: Runs automatically before BMAD to customize the pipeline

## Interactive flow

Ask the user these questions one at a time. Adapt follow-up questions based on answers.

### 1. Project type
"What type of project is this?"
- Web application (frontend + backend)
- API / Backend service
- Library / Package
- Mobile app
- CLI tool
- Documentation site
- Other (describe)

### 2. Tech stack
"What languages and frameworks does this project use?"
- Suggest triggers based on the answer (e.g., React → `[ui, ux, component, jsx, hook, responsive]`)

### 3. Pipeline gates
"Which quality gates should run on every PR?"
- Show the available specialists with short descriptions:
  - `architect` — architecture review, ADRs
  - `frontend` — UI/UX review
  - `backend` — API, database review
  - `fullstack` — end-to-end feature review
  - `devops` — Docker, CI/CD, infra review
  - `security` — adversarial security review
  - `qa` — tests, specs, coverage
  - `doc` — documentation review
  - `marketing` — SEO, copy review
  - `design` — UI/UX design review
  - `product` — requirements, acceptance criteria
  - `bizdev` — business development review
- Pre-select reasonable defaults based on project type
- Let the user add/remove

### 4. Parallel vs sequential
"Should all gates pass before merging, or can they run in parallel?"
- `require_all: true` (default, safer) — gates run sequentially, all must pass
- `require_all: false` — gates run in parallel, non-blocking

### 5. Retry behavior
"How many automatic retries before escalating to a human?"
- Default: 3
- `retry_upgrade: true` means the agent upgrades to a bigger model on retry

### 6. Review and confirm
Show the generated YAML and ask for confirmation:
```yaml
# .coderclaw/rules.yaml
pipeline:
  gates: [...]
  require_all: true/false
  max_retries: 3
  retry_upgrade: true

specialists:
  ...(customized triggers)...
```

"Does this look good? Type 'yes' to save, or tell me what to change."

## Output

Save the generated rules to:
- `$BMAD_OUTPUT_DIR/coderclaw-rules.yaml` (for /spec init to pick up)
- Or show the YAML for the user to copy into their repo manually

## Manual alternative

Users can skip this interactive session and edit `.coderclaw/rules.yaml` manually. See the README for the full format reference.
