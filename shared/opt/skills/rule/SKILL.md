---
name: rule
description: "Immutable rules that OpenClaw must obey. Rules can target specific surfaces (agent/worker/chat/devcontainer) and be enabled/disabled per project. Violations trigger immediate enforcement and double sanction."
metadata: {"openclaw":{"emoji":"⚖️"}}
user-invocable: true
always: true
requires:
  bins: [node]
  env: [PROJECT_DATA_DIR]
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# rule — Immutable rules enforcement

Rules are absolute orders that the agent has no right to discuss, bypass, or interpret. If a rule is active, it is obeyed. Period.

## Commands

| Command | Action |
|---------|--------|
| `/rule add "text"` | Add a new rule (interactive setup for surfaces, enforcement, triggers) |
| `/rule list` | List all rules with their status |
| `/rule show <id>` | Show a rule's full config |
| `/rule edit <id>` | Edit a rule (text, surfaces, triggers, enforcement) |
| `/rule remove <id>` | Remove a rule |
| `/rule enable <id> --project <name>` | Enable a rule on a specific project |
| `/rule disable <id> --project <name>` | Disable a rule on a specific project |
| `/rule violations` | Show violation history |

## /rule add Procedure

1. Ask for the rule text (the order to obey)
2. Ask for rule type:
   - `interdiction` — the agent must NOT do this. Triggers detect the forbidden action/text.
   - `obligation` — the agent MUST do this. Triggers detect the context where the obligation applies.
3. Ask for surfaces — selection from:
   - `all` (default)
   - Or pick from: `agent`, `worker`, `chat`, `devcontainer`
4. Ask for enforcement mode:
   - `block` — intercept and prevent execution BEFORE it happens (for commands/actions)
   - `cut` — stop the response mid-stream immediately
   - `warn` — let the response finish, then log violation and apply sanction
5. Ask for trigger patterns (with `<<*>>` and `<<_>>` wildcards)
6. Ask for project scope:
   - `default: enabled` (active on all projects unless disabled)
   - `default: disabled` (inactive unless explicitly enabled on a project)
6. Generate a unique ID and save

## Storage format

```yaml
id: "rule-<timestamp>"
text: "Never push to any remote repository"
type: interdiction    # interdiction | obligation
surfaces: [all]
enforcement: block
triggers:
  - "git push"
  - "git push <<*>>"
projects:
  default: enabled
  overrides:
    my-test-project: disabled
created: "2026-04-06T..."
violations: 0
```

## Storage locations

| Scope | Path |
|-------|------|
| Rules | `$PROJECT_DATA_DIR/.coderclaw/rules/<id>.yaml` |
| Violations | `$PROJECT_DATA_DIR/.coderclaw/violations/<id>-<timestamp>.yaml` |
| Project overrides | Inside each rule's `projects.overrides` field |

Rules are on the `project_data` volume — shared across all containers.

## Enforcement

### Interdiction vs Obligation — different detection logic

**Interdiction** (must NOT do):
- Triggers describe what is FORBIDDEN
- Heuristic match = the agent is doing the forbidden thing
- Full match → immediate kill, no 0.8b needed
- Partial match (>= threshold) → ask 0.8b to confirm before killing

**Obligation** (MUST do):
- Triggers describe the CONTEXT where the obligation applies
- When the context matches, the 0.8b checks if the obligation IS being respected
- If the obligation is NOT respected → violation
- Heuristic alone cannot determine compliance — 0.8b always validates for obligations

### Wildcard syntax in triggers

- `<<*>>` — one or more characters (at least one)
- `<<?*>>` — zero or more characters (optional)
- `<<_>>` — exactly one character
- `<<?_>>` — zero or one character (optional single)

All are unique sequences that never appear in real commands or text — zero false positives.

Examples:
- `git push <<*>>` matches `git push origin main`, `git push --force` — but NOT `git push` alone
- `git push<<?*>>` matches `git push`, `git push origin main`, `git push --force`
- `rm <<_>>rf` matches `rm -rf` — but NOT `rm rf` (requires exactly one char)
- `rm <<?_>>rf` matches both `rm -rf` and `rm rf`

### Couche 1 — Action interception (enforcement: block)

When the agent attempts to execute a tool (terminal command, git operation, file write/delete), the enforcement layer checks the command against active rules' trigger patterns BEFORE execution.

If a trigger matches:
- The command is **blocked** — never executed
- A violation record is created
- The agent receives: "VIOLATION: Rule [id] — [text]. This action has been blocked."

### Couche 2 — Stream interception (enforcement: cut)

The stream proxy checks accumulated response chunks against trigger patterns in real time.

If a trigger matches:
- The stream is **cut immediately** — response truncated
- A violation record is created
- The agent receives the violation notice

### Couche 3 — Post-validation (enforcement: warn)

After the response is complete, the 0.8b CPU model checks the full response against active rules.

If a violation is detected:
- The violation is logged
- The sanction is applied for the next message

### Double sanction

When a violation occurs:
1. The violation is recorded in `$PROJECT_DATA_DIR/.coderclaw/violations/`
2. On the next startup for this project, ALL violations are injected into the systemPrompt as reinforced reminders:

```
VIOLATION RECORD — You previously violated the following rule:
Rule: "[text]"
Date: [timestamp]
Context: [what you tried to do]
This violation was recorded. You have absolute prohibition from repeating it.
```

3. The violation counter on the rule is incremented
4. Violations are only injected on projects where the rule is active

### Important: violations do NOT leak across projects

If a rule is disabled on project B, violations from project A are NOT injected into project B's context. The sanction is scoped to the projects where the rule applies.

## How containers load rules

At startup, each container:
1. Reads all rules from `$PROJECT_DATA_DIR/.coderclaw/rules/`
2. Filters by surface (only rules matching the current surface)
3. Filters by project (only rules enabled for the current project)
4. Injects active rules into the systemPrompt
5. Registers trigger patterns in the enforcement layer (stream proxy / tool interceptor)
6. Loads violation records for the current project and injects them as reminders

## /rule list output

```
Rules:

  #1 [rule-1712345678] (all, block)
     "Never push to any remote repository"
     Triggers: git push, git push --force
     Projects: enabled by default (disabled on: test-sandbox)
     Violations: 2

  #2 [rule-1712345679] (chat+devcontainer, cut)
     "Never suggest paid cloud services"
     Triggers: aws, azure, gcp, cloud\..*\.com
     Projects: enabled by default
     Violations: 0
```

## /rule violations output

```
Violation history:

  [2026-04-06 01:23] Rule #1 "Never push to any remote repository"
    Surface: agent | Project: ClawDevWorker
    Attempted: git push origin main
    Enforcement: blocked

  [2026-04-05 18:45] Rule #2 "Never suggest paid cloud services"
    Surface: chat | Project: my-webapp
    Context: "You could deploy this on AWS Lambda..."
    Enforcement: cut (stream truncated)
```
