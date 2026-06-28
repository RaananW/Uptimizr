---
"@uptimizr/db": minor
"@uptimizr/react": minor
---

Surface opt-in engine diagnostics in the dashboard (#16, ADR 0021 part 2). Adds a
dialect-agnostic `buildGraphicsDiagnosticCounts(projectId, opts, dialect)` aggregation to
`@uptimizr/db` that rolls `graphics_diagnostic` events up into `(severity, category, backend)`
incident counts, folding discrete markers (no `count`) and per-session rollups (`count: N`)
honestly as `SUM(COALESCE(count, 1))`. The fields ride in stored JSON (nothing promoted to a
column), so extraction goes through the existing `jsonText` helper plus a new nullable
`Dialect.jsonInt(column, ...path)` so the `count` cast stays identical across DuckDB and
ClickHouse (covered by a `PARITY_CASES` entry).

`@uptimizr/react` gains a `graphicsDiagnosticCounts()` query-client method (and
`GraphicsDiagnosticCount` type) hitting the new `GET /api/v1/graphics-diagnostics` collector
endpoint. Capture is off by default, so the new dashboard "Engine diagnostics" panel shows an
explicit opt-in empty state until `captureGraphicsDiagnostics` is enabled.
