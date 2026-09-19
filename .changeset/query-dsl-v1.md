---
"@uptimizr/schema": minor
"@uptimizr/metrics": minor
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/agent-core": minor
"@uptimizr/mcp": minor
---

**Query DSL v1** (ADR 0051 §3): every metric the collector can compute now answers to **one**
endpoint, `POST /api/v1/query` — and `GET /api/v1/query?q=<url-encoded JSON>` for GET-only clients.
Name the `metric`, bound it with a required `range`, narrow it with the filters that metric declares,
cap it with `limit`, and pick the envelope with `format` (which defaults to `table` here). Both forms
are reads: the same `query` capability, the same audit trail, the same aggregations.

The grammar is **closed** — `queryV1Schema` in `@uptimizr/schema` — with no SQL, no expression
language, typed filters, bounded output and unknown keys rejected. The metric, dimension and filter
vocabularies are exactly the registry's: `validateQuery()` in `@uptimizr/metrics` checks a query
against it and returns every objection as data, each with a stable `code`, the offending path and —
where it is a closed list — the values that _would_ have been accepted, so a wrong guess comes back
as a correction rather than an empty result an agent would report as a finding.

v1 is the **delegated** tier: `compileQuery` in `@uptimizr/db` maps a query onto the metric's
existing aggregation builder through the registry's `FILTER_TARGETS`, and every store runs it with
the one new `runMetric` method. So a DSL query compiles to the _identical_ `QuerySpec` the canned
endpoint runs — asserted per metric on all four dialects, with `dsl:*` parity cases executing
compiled specs against the same goldens — and it inherits parameter binding, numeric coercion at the
store edge and cross-engine parity without a second SQL path. `dimensions` must therefore be the
metric's own grain, and `compare`, `segment`, `order`, `explain`, `filters.event` and
`filters.device` are part of the published grammar but answer `400 … not supported yet`.

`@uptimizr/agent-core` gains one generated `query` tool whose input _is_ the DSL (appended to
`readTools`, so every existing tool name and schema is unchanged), reaching the collector over the
GET form so the read-only `CollectorClient` stays `GET`-only. `@uptimizr/mcp` registers it with an
output schema and lists it in `uptimizr://capabilities` alongside the per-metric tools.
