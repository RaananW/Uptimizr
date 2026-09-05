---
"@uptimizr/react": minor
---

Assistant (`/assistant` subpath): replies now stream in incrementally for both the local (WebLLM) and hosted backends. `useAssistant` exposes `partialText` — the answer streamed so far for the in-flight turn (`null` when nothing is streaming; text a tool-calling turn streams is discarded when that turn ends, so it never shows tool chatter) — and `<AssistantPanel>` renders it live as the assistant bubble, with the busy indicator turning into **Streaming…** once tokens arrive. The partial bubble is replaced by the final assistant turn in the same render (never duplicated), the streamed tokens are kept out of the `aria-live` status region, and the no-text-answer fallback still applies.
