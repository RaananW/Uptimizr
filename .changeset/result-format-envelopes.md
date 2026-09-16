---
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
---

Add a shared `format=full | table | summary` envelope to every aggregate query endpoint (ADR 0051 §2).

`format` filters nothing — it selects the shape the rows come back in. **`full` is the default and
is unchanged**, byte for byte, so the dashboard and every existing client are unaffected (a sweep
over the parity fixtures asserts each endpoint's default body still hashes to what it returned
before this change). `table` keeps the rows and adds a `meta` envelope: the metric, the requested
range, the applied filters, the sample size, the row count, whether the row cap truncated the
result, and the registry limits. `summary` returns a **bounded** digest capped at the metric's
`limits.maxSummaryRows`, so a 500-bin heatmap costs an agent the same number of tokens as a 5-bin
one.

`@uptimizr/db` gains the summariser behind it on a new browser-safe `@uptimizr/db/summary` subpath
(also re-exported from the package root): `summarizeRows(metric, rows, ctx)`,
`tableResult(metric, rows, ctx)`, the `clusterCells` spatial helper, `wilsonInterval`, and Zod
schemas for all three envelopes. It is pure and registry-driven — the metric's `grain` picks the
shape: ranked `top[]` rows with shares and a `rest` bucket for a leaderboard; a
`first / last / min / max / trend / slope` series for a `bucket` grain; deterministic greedy-merged
clusters (8-neighbourhood for 2D bins, 26 for voxels, ranked by summed weight, each reporting
centroid, extent, cells, weight and share) for `bin` and `voxel` grains; and the row itself plus its
`rateOf` rates for a single-row metric. Every summary carries a sample size derived from the
registry's column units, the metric's caveats plus any true only of that result, `drill` hints
naming filters the metric actually accepts, and a `reading` sentence templated from column semantics
alone — no model is involved, so the same rows always produce the same words. Shares, `total` and
the Wilson `confidence` note are reported only where the measure's unit can honestly be summed.

Registry additions: `"format"` is a `FilterId` and is declared on all 67 metrics served on a
querystring endpoint, and `ColumnSemantics` gains an optional `axis` flag marking the ordered column
of a `bucket`-grain metric (`label` cannot double as the axis — `mesh_trend` labels its rows by
mesh). Each affected route's 200 response schema is now the union of the three envelopes, with the
untouched `full` shape first.
