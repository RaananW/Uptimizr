---
"@uptimizr/agent-core": minor
"@uptimizr/react": minor
---

Make the local (WebLLM) analytics assistant genuinely useful, not just
non-crashing, within the in-browser 7–8B Hermes ceiling (ADR 0050).

- **Current-time grounding.** The assistant now stamps the current time (ISO 8601
  - epoch ms) into the system prompt at send time via a new
    `composeSystemPrompt(base, nowMs)` helper and an injectable `useAssistant({ now })`
    clock (default `Date.now`). Small local models can finally resolve relative
    ranges ("today", "this week", "last 24h") into concrete `since`/`until` args —
    the fix for simple time-scoped questions returning no answer.
- **Focused core tool set for local.** `@uptimizr/agent-core` adds
  `coreReadTools`, `CORE_READ_TOOL_NAMES`, and `selectReadTools(kind)` — a
  filtered VIEW of the existing `readTools` (schema still lives once). The React
  hook sends the ~7-tool core subset to the **local** backend and the full 20 to
  **hosted** backends, so a 4-bit local model isn't overwhelmed.
- **Strongest curated default.** `CURATED_MODELS` is reordered strongest-first so
  the default is Hermes 3 (Llama 3.1 8B); all three stay selectable.
- **Guided example prompts** in `<AssistantPanel>` (single-core-tool starter
  questions) and an honest local-vs-hosted capability note.
