---
"@uptimizr/react": patch
---

fix(assistant): let users return to backend selection and switch local↔hosted anytime.
The `<AssistantPanel>` now exposes a discoverable **Change backend** control that reopens the
side-by-side selection cards at any time (with a **Back to chat** escape), so a committed backend
is no longer a dead end. Switching between local and hosted works end to end (the previous model
is released, freeing GPU memory), and re-picking the same kind prefills the current model/key.
