---
"@uptimizr/collector-server": minor
"@uptimizr/mcp": minor
"@uptimizr/agent-core": patch
---

Generate the collector's self-description from the semantic metric registry (ADR 0051 §1).

- **`@uptimizr/collector-server`** serves a new, unauthenticated
  `GET /api/v1/openapi.json`: an OpenAPI 3.1 document built from the metric registry and the
  server's own route table, so every path, parameter schema and response schema comes from the
  code that actually serves and validates the request. Semantics OpenAPI cannot express —
  result grain, per-column units, caveats, interpretation, capture channels, row limits,
  dimensions, related metrics and comparison direction — ride along as `x-uptimizr-*` vendor
  extensions. Rate-limited like every other route; it contains no project data.
- **`@uptimizr/mcp`**'s `uptimizr://capabilities` resource is now built from the registry and
  gains a `metrics` array: the whole registry minus the SQL builder, with each row schema as
  JSON Schema. Existing keys (`schemaVersion`, `readOnly`, `eventTypes`, `params`, `tools`,
  `notes`) are unchanged.
- The tool/endpoint tables in the packaged `README.md`, `AGENTS.md` and `llms.txt` of
  **`@uptimizr/mcp`** and **`@uptimizr/agent-core`** are now rendered from the registry by
  `scripts/gen-registry-docs.mjs`, with a CI staleness gate (`pnpm gen:docs:check`).
