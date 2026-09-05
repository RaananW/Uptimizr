---
"@uptimizr/react": patch
---

Assistant: refresh the current-time stamp in the system prompt on **every** send, not just the first turn. The conversation's single system message is updated in place (never duplicated), so a long-lived conversation that crosses a calendar boundary still resolves "today" / "this week" against the real current time. Adds the pure `refreshSystemPrompt(messages, basePrompt, nowMs)` helper on the `/assistant` subpath.
