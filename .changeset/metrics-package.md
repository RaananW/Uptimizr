---
"@uptimizr/metrics": minor
---

New package: `@uptimizr/metrics`, the semantic metric registry (ADR 0051 §1). One
`MetricDefinition` per Uptimizr analytics metric — id, title, agent-facing description, collector
endpoint, result grain, group-by dimensions, accepted filters, the output row schema (Zod),
per-column units and semantics, row limits, interpretation, caveats, source capture channels,
related metrics and comparison semantics — plus the closed `DimensionId` / `FilterId` vocabularies,
the `FILTER_TARGETS` glossary and the `AGGREGATION_BUILDER_NAMES` list.

The registry previously lived in `@uptimizr/db` on a (never-released) `@uptimizr/db/registry`
subpath. A pure subpath was not enough: a package manager installs a package's dependencies, not
the subset a subpath reaches, so every consumer of the registry also downloaded `@duckdb/node-api`
— a ~37 MB native binding a browser bundle or an `npx` MCP client can never use. This package's
only runtime dependencies are `zod` and `@uptimizr/schema`; it performs no I/O, touches no `node:`
built-in and holds no reference to a store or a dialect.

Every export keeps the name it had.
