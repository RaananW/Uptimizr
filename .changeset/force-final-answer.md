---
"@uptimizr/agent-core": patch
---

Force a final, tools-disabled synthesis turn so the assistant always replies.
Small local WebLLM (Hermes 7–8B) models often returned an empty `final` answer —
or kept tool-calling until the step cap — so the loop ended with no reply. When a
run would otherwise end without a usable answer (an empty final, or `maxSteps`
reached while still tool-calling), `runAgent` now makes one extra
`provider.complete()` with tools disabled, forcing the model to compose a
plain-text answer from the tool results it already gathered (at most one such
forced turn per run; on/off via `forceFinalAnswer`, default `true`). The hosted
(OpenAI/Anthropic) and WebLLM adapters now omit `tools`/`tool_choice` entirely
when no tools are offered so the model answers in prose. Oversized tool results
are also truncated (plain slice + marker, tunable via `maxToolResultChars`,
default 8000) to protect small models' context. Still local-only for the local
backend — no new data egress.
