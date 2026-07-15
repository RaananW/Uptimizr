---
"@uptimizr/react": minor
---

feat(react): ship the in-browser analytics assistant as a portable, code-split export — a drop-in
`<AssistantPanel>` and a headless `useAssistant()` hook from the new `@uptimizr/react/assistant`
subpath (ADR 0050 §2, ADR 0047).

- `useAssistant()` wraps `@uptimizr/agent-core`'s `runAgent` tool-calling loop: it manages the
  conversation history and per-turn state, the user-selected LLM backend (persisted via agent-core's
  config helpers), live tool-call progress, and WebLLM download/init progress. The loop runs
  entirely client-side against the **same** read-only `CollectorApi` client the panels use (no new
  transport, no Uptimizr server component).
- `<AssistantPanel>` is a drop-in chat UI on the hook: message list, input, a local-WebLLM vs
  bring-your-own-hosted backend/model picker, the WebLLM download-consent prompt + progress bar, and
  clear privacy messaging.
- LLM deps stay **optional and code-split**: importing the core `@uptimizr/react` barrel pulls zero
  assistant/LLM code, the provider factories are `import()`-ed on first use, and `@mlc-ai/web-llm`
  remains an optional peer loaded lazily by agent-core — exactly like `@uptimizr/react/panels-3d`
  code-splits Babylon.
- Adds a read-only `CollectorApi.read()` passthrough and a non-throwing `useOptionalUptimizr()` so
  the assistant reuses an ambient `<UptimizrProvider>` connection or explicit `collectorUrl`/`apiKey`
  props.
