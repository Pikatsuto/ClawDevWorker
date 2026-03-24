---
name: forget
description: "Controlled context deletion. Removes messages from the conversation to unblock a stuck discussion without starting over. In autonomous mode (worker), integrates with loop-detect to clear failed approaches and retry with a fresh perspective."
metadata: {"openclaw":{"emoji":"🧹"}}
user-invocable: true
always: false
---

**Language**: Always respond in the user's language. Adapt all output, explanations and messages to match the language the user is communicating in.

# forget — Controlled context deletion

## Commands (interactive mode — chat / devcontainer)

| Command | Action |
|---------|--------|
| `/forget preview` | Show what would be deleted (dry run) |
| `/forget last` | Delete the last exchange (user message + AI response) |
| `/forget last N` | Delete the last N messages |
| `/forget since Xm` | Delete all messages from the last X minutes |
| `/forget message <id>` | Delete a specific message by ID |

## /forget preview Procedure

1. Determine what would be deleted based on the next command's expected scope
2. Display a summary:
   ```
   Would delete 5 messages (last 12 minutes):
     - [12:34] User: "Try using a different regex..."
     - [12:35] AI: "Here's the updated regex..."
     - [12:38] User: "That doesn't work either..."
     - [12:39] AI: "Let me try another approach..."
     - [12:42] User: "Still broken..."
   ```
3. Ask for confirmation: "Proceed with `/forget last 5`?"

## /forget last [N] Procedure

1. If no N specified, N = 2 (one exchange = user message + AI response)
2. Identify the last N messages in the conversation history
3. Call OpenClaw context management API to remove these messages
4. If API not available: serialize the current agent state, truncate the message history, restart the agent with the truncated context
5. Confirm: "Forgot the last N messages. Context cleaned."

## /forget since Xm Procedure

1. Parse the duration (e.g., `10m` = 10 minutes, `1h` = 1 hour)
2. Identify all messages with timestamp within the last X minutes
3. Same deletion mechanism as `/forget last`
4. Confirm: "Forgot N messages from the last X minutes."

## /forget message <id> Procedure

1. Locate the message by ID in the conversation history
2. Delete only that specific message
3. Confirm: "Message <id> removed from context."

## Technical implementation

### If OpenClaw exposes a context management API:
```javascript
// Ideal: direct message deletion
await openclaw.context.deleteMessages({ count: N });
// or
await openclaw.context.deleteMessagesSince({ minutes: X });
```

### If OpenClaw does NOT expose this API (fallback):
```bash
# 1. Serialize current state
STATE_FILE="/tmp/forget-state-${AGENT_ID}.json"
node -e "
  const state = JSON.parse(require('fs').readFileSync(process.env.OPENCLAW_STATE_FILE));
  state.messages = state.messages.slice(0, -${N});
  state.messages.push({
    role: 'system',
    content: 'Context was cleaned. ${N} previous messages were removed by /forget.'
  });
  require('fs').writeFileSync('${STATE_FILE}', JSON.stringify(state));
"

# 2. Restart agent with truncated state
openclaw agent start --config "$CONFIG_FILE" --agent-id "$AGENT_ID" --restore "$STATE_FILE"
```

---

# Autonomous mode — Worker integration with loop-detect

## How it works

When `loop-detect` detects a loop in a headless worker, instead of immediate FAIL:

1. **loop-detect** signals the loop (existing mechanism)
2. **forget** receives the loop context: which messages form the loop, what approaches were tried
3. **forget** deletes the loop messages from the context
4. **forget** injects a concise redirection pre-prompt:

```
The previous approaches failed. Here is what was tried:
- Approach 1: [one-line description] — failed because [reason]
- Approach 2: [one-line description] — failed because [reason]

Take a completely different direction. Do NOT retry any of the above approaches.
```

5. The worker resumes with a clean context + knowledge of what didn't work
6. **forget** notifies the orchestrator for traceability:

```bash
curl -sf -X POST "${ORCHESTRATOR_URL}/forget-event" \
  -H "Content-Type: application/json" \
  -d "{
    \"repo\": \"${REPO}\",
    \"issueId\": ${ISSUE_ID},
    \"role\": \"${ROLE}\",
    \"messagesRemoved\": ${N},
    \"approachesTried\": [\"...\"],
    \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }"
```

## Limits

- **1 forget + retry per gate maximum.** If the worker loops again after a forget, it's a definitive FAIL.
- The redirection pre-prompt must be **concise** — one line per failed approach. No detailed summary (that would recreate the problem).
- The orchestrator logs all forget events so the human can review what happened after the fact.

## Integration with loop-detect

In the loop-detect SKILL.md, the headless action section should be updated to:

```
When in headless mode and a loop is detected:
  1. If no /forget has been used yet in this gate:
     → Trigger /forget on the loop messages
     → Inject redirection pre-prompt
     → Continue working
  2. If /forget was already used once:
     → Signal FAIL via POST /task-complete
     → Include the full summary of both attempts
```
