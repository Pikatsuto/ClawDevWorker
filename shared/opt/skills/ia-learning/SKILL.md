---
name: ia-learning
description: "Controlled learning sessions for the AI. The user guides the model through research, exercises, explanations. Notes are compiled into persistent pre-prompts with heuristic YAML triggers for automatic context injection by the orchestrator."
metadata: {"openclaw":{"emoji":"🎓","requires":{"bins":["node"]}}}
user-invocable: true
always: false
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# ia-learning — Controlled AI learning sessions

## Commands

| Command | Action |
|---------|--------|
| `/ia-learning start` | Start a new learning session |
| `/ia-learning review` | Present notes for human validation before compilation |
| `/ia-learning stop "name"` | Compile validated notes into a named learn |
| `/ia-learning list` | List all available learns for the current project |
| `/ia-learning show "name"` | Display a specific learn's content and triggers |
| `/ia-learning inject "name"` | Force-inject a learn into the current context |
| `/ia-learning enrich "name"` | Resume a session to add to an existing learn |

## /ia-learning start Procedure

1. Announce the session: "Learning session started. I will take structured notes as we go."
2. Set internal state: `LEARNING_MODE=true`
3. Create a temporary notes buffer (in-memory, not persisted yet)
4. During the session:
   - Research via mcp-docs, SearXNG, documentation as needed
   - Take structured notes after each exchange — facts, patterns, constraints, examples
   - Correct notes when the human corrects understanding
   - Notes are organized by topic, not chronologically

## /ia-learning review Procedure

1. Present all accumulated notes to the human, organized by topic
2. For each topic, show:
   - What was learned (facts, patterns)
   - Key constraints or gotchas
   - Practical examples if any
3. The human validates, corrects, or asks to remove items
4. Update notes based on feedback
5. Confirm: "Notes validated. Use `/ia-learning stop "name"` to compile."

## /ia-learning stop "name" Procedure

1. Verify notes have been reviewed (`/ia-learning review` must have been called)
2. Compile notes into two files:

### Learn pre-prompt (`.md`)

```markdown
# Learn: {name}

## Key facts
- [fact 1]
- [fact 2]

## Patterns and conventions
- [pattern 1]

## Constraints and gotchas
- [constraint 1]

## Examples
- [example if relevant]
```

The pre-prompt is written as direct instructions — not a summary, not a narrative.
Each point must be actionable and self-contained.

### Heuristic YAML (`.yaml`)

```yaml
name: "{name}"
description: "{one-line description}"
triggers:
  - keyword1
  - keyword2
  - technology_name
  - pattern_name
priority: normal  # normal | high | critical
created: "YYYY-MM-DD"
usage_count: 0
last_used: null
```

Trigger words must be specific enough to avoid false positives.
Use technology names, library names, specific patterns — not generic words like "code" or "fix".

3. Write both files to the learns directory:

```bash
LEARNS_DIR="${PROJECT_DATA_DIR}/${PROJECT_NAME}/.coderclaw/learns"
mkdir -p "$LEARNS_DIR"
# Write: $LEARNS_DIR/{name}.md
# Write: $LEARNS_DIR/{name}.yaml
```

4. Confirm: "Learn '{name}' saved with N triggers. It will be automatically injected when relevant."

## /ia-learning enrich "name" Procedure

1. Load the existing learn (`.md` + `.yaml`)
2. Present current content to the human
3. Resume learning session — new notes are appended to existing ones
4. On `/ia-learning stop "name"`, merge new notes with existing content
5. Update the `.yaml` triggers if new topics were covered

## How learns are injected (by the orchestrator, not by this skill)

This skill only creates and manages learns. The orchestrator handles injection:

1. **Heuristic layer (0ms)**: regex match of YAML triggers against message keywords
2. **CPU 0.8b validation (only if trigger matches)**: the 0.8b model receives the learn content + current message and either:
   - Extracts the relevant passages (1.5 lines min, 20% of message max)
   - Responds `NO_MATCH` if the trigger was a false positive
3. The extracted passage is injected transparently into the GPU model's context

Learns marked `priority: critical` bypass the 0.8b filter and are injected in full when triggered.

## Anti-pollution mechanism

- `usage_count` is incremented each time a learn is injected
- Learns not used for a long time are automatically deprioritized
- Configurable limit on simultaneous learn injections (default: 3 per message)
- The human can force-inject any learn via `/ia-learning inject "name"`

## Storage

- Location: `$PROJECT_DATA_DIR/$PROJECT_NAME/.coderclaw/learns/`
- Each learn = `{name}.md` (pre-prompt) + `{name}.yaml` (heuristic metadata)
- Shared across all containers via the `project_data` volume
- A learn created in the chat is immediately available to workers and devcontainer
