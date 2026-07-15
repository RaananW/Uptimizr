---
"@uptimizr/react": minor
---

feat(react): explicit first-run LLM backend chooser for the assistant (ADR 0050 §4, amended).

`useAssistant` and `<AssistantPanel>` no longer auto-select a backend on first open. Previously a
WebGPU machine was pre-selected into the local (WebLLM) backend, dropping a first-time user straight
onto the ~4 GB model-download gate without seeing the hosted alternative.

- `useAssistant`: when no explicit `backend` is passed and none is persisted, the selection now
  starts **unselected** (`null`) — nothing loads until the user chooses. The explicit-`backend` and
  persisted-choice fast paths are unchanged, so returning users are never re-prompted.
- `<AssistantPanel>`: on first run it renders a **chooser** presenting both backends side by side
  with honest tradeoffs (including the hosted data-egress caveat), local shown disabled with a
  "requires a WebGPU browser" note when WebGPU is unavailable and highlighted as _Recommended_ when
  it is. Picking an option routes into the existing per-backend config (local model dropdown +
  download consent, or the hosted endpoint/key/model form). The choice persists; subsequent opens go
  straight to the chat, and the backend can still be changed later under **Backend**.
