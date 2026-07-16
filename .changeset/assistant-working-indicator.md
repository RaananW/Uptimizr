---
"@uptimizr/react": patch
---

Make the in-browser analytics assistant show that it is working and never hide
its reply. `<AssistantPanel>` now renders an always-visible spinner + status
label (`Loading model…` / `Running analytics…` / `Thinking…`) in an `aria-live`
region while a turn is in flight — so non-streaming local (WebLLM) generation no
longer looks frozen. A turn that finishes without a natural-language answer (only
tool calls, or the step cap was hit) now shows an explicit fallback line instead
of rendering nothing, and the conversation area scrolls and auto-follows the
newest message so answers stay in view. `useAssistant` exposes a new
`noTextAnswer` flag for custom UIs.
