---
name: bmad
description: "BMAD Method (Breakthrough Method of Agile AI Driven Development). Orchestrates the complete generation of project specs: product brief → PRD → architecture → epics and user stories with dependencies. Used by /spec init to initialize a project before creating Forgejo issues. Two modes: interactive (dialogue with the user) or batch (from an existing brief.md)."
metadata: {"openclaw":{"emoji":"📋"}}
user-invocable: true
always: false
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# BMAD Method — Structured Project Spec

## Available commands

| Command | Action |
|---------|--------|
| `/bmad brief` | Starts the interactive product brief |
| `/bmad prd` | Generates the PRD from the brief |
| `/bmad arch` | Generates the technical architecture |
| `/bmad stories` | Generates epics and user stories with dependencies |
| `/bmad full` | Chains all 4 phases in interactive mode |
| `/bmad batch <brief.md>` | Batch mode from an existing brief file |
| `/bmad status` | Current workflow status |

## Usage in /spec init

`/spec init` calls BMAD automatically. You don't need to call `/bmad` manually unless you want to work on the spec without creating a project.

## USER_STORIES.md format expected by create-issues.js

Each story MUST follow this format so that issues and the DAG are generated correctly:

```markdown
## US-001 — Story title

**As a** [persona]
**I want** [action]
**So that** [benefit]

**Depends on:** US-002, US-003
*(omit this line if no dependencies)*

### Acceptance criteria

- [ ] criterion 1
- [ ] criterion 2
- [ ] criterion 3
```

## Interactive mode procedure (/bmad full)

Load the workflow from `/opt/skills/bmad/workflows/` and guide the user phase by phase.

```bash
WORKFLOWS_DIR="/opt/skills/bmad/workflows"
OUTPUT_DIR="${PROJECT_DIR:-/workspace}/_bmad-output"
mkdir -p "$OUTPUT_DIR/planning-artifacts"

# Phase 1: Product brief
cat "$WORKFLOWS_DIR/product-brief.md"
# → interactive dialogue with the user
# → generates: $OUTPUT_DIR/planning-artifacts/product-brief.md

# Phase 2: PRD
cat "$WORKFLOWS_DIR/create-prd.md"
# → generates: $OUTPUT_DIR/planning-artifacts/PRD.md

# Phase 3: Architecture
cat "$WORKFLOWS_DIR/create-architecture.md"
# → generates: $OUTPUT_DIR/planning-artifacts/ARCHITECTURE.md

# Phase 4: Stories
cat "$WORKFLOWS_DIR/create-epics-and-stories.md"
# → generates: $OUTPUT_DIR/planning-artifacts/USER_STORIES.md
#   IMPORTANT: include dependencies "**Depends on:** US-NNN"
```

## Batch mode procedure (/bmad batch <brief.md>)

```bash
BRIEF_FILE="$1"
# Read the brief and generate PRD + ARCHITECTURE + USER_STORIES in one pass
# in autonomous mode without user interaction
# Use the complex model for generation quality
```
