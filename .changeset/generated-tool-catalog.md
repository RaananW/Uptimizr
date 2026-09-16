---
"@uptimizr/agent-core": minor
"@uptimizr/mcp": minor
"@uptimizr/react": minor
---

Generate the read-only tool catalog from the metric registry (ADR 0051 §1). `readTools` is no
longer a hand-written array of 20 tools: `registryToTools()` derives one tool per `@uptimizr/db`
metric that the collector serves on a read endpoint — **69** today — with the metric's
interpretation notes and caveats in its description, an input schema built from the endpoint's
filters and path parameters, and a new `ReadTool.outputSchema` (`{ rows: Row[] }`) derived from the
metric's row schema. `@uptimizr/mcp` registers that as the MCP `outputSchema` and now returns
`structuredContent` alongside the JSON text, so `tools/list` covers the whole read surface —
dead/rage clicks, jank, per-device and per-scene FPS, coverage, blind spots, scene retention, the
variant leaderboard and the load→bounce funnel included.

The 20 tool names that shipped before the registry, and their argument schemas, are unchanged; a
frozen-fixture test pins them, and the only widening is optional parameters the endpoints already
accepted. `@uptimizr/agent-core` stays browser-safe: it reads the registry from the
dependency-free `@uptimizr/metrics` package and never depends on `@uptimizr/db`, proven by a
browser bundle test and a manifest test.

New: `registryToTools()` and `filterReadTools(names)` in `@uptimizr/agent-core`, and a `tools`
option on `@uptimizr/react`'s `useAssistant()` to pin which read tools an assistant may call
(the per-backend default — the core subset locally, the full catalog hosted — is unchanged).
