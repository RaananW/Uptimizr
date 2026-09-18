---
"@uptimizr/collector-server": minor
"@uptimizr/agent-core": minor
"@uptimizr/metrics": minor
"@uptimizr/react": minor
"@uptimizr/mcp": minor
"@uptimizr/db": minor
---

Project context resource, custom-event vocabulary and assistant prompt injection (ADR 0051 §5).

`GET /api/v1/context` (and the MCP `uptimizr://context` resource) describes the project an agent is
looking at in one bounded, briefly-cached read: scenes with their labels and named regions, the
discovered custom-event vocabulary with observed prop keys and coarse types, top meshes and bound
input actions, capture channels seen, data freshness and retention flags, the store engine and
versions, and the metrics that will return empty because every capture channel feeding them is off.

A new `custom_event_vocabulary` metric (`GET /api/v1/vocabulary/custom-events`) serves the vocabulary
on its own and becomes a generated agent tool. The in-browser assistant fetches the context and
injects a compact rendering (`renderContextForPrompt` in `@uptimizr/agent-core`) into its system
prompt, degrading silently against a collector too old to serve it.
