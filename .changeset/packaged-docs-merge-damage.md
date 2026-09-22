---
"@uptimizr/metrics": patch
"@uptimizr/schema": patch
"@uptimizr/db": patch
"@uptimizr/agent-core": patch
"@uptimizr/mcp": patch
"@uptimizr/react": patch
"@uptimizr/collector-server": patch
---

Packaged agent docs: repair the contradictory fragments the wave-2 integration merge left behind.
Every duplicated paragraph or bullet now appears once, with the statement that is actually true of
this release: five insight primitives rather than three or four, one `Types:` line in
`@uptimizr/metrics`' `llms.txt` instead of three, one `query:raw` paragraph in `@uptimizr/mcp`'s
guide instead of two that disagreed about whether `session_narrative` exists, and the packaged
skill names spelled as they ship (`xr_comfort_audit`, plus `conversion_investigation` and
`performance_regression_triage`). Tool and metric counts are recomputed from the registry — 78
metrics, 76 served on a read endpoint, 77 tools on a plain `query` key — and the "read-only"
claims now say what they mean: events are read-only, metadata writes need `annotate`, and
`session_narrative` needs `query:raw`.
