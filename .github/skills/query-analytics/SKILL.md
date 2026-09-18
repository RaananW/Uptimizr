---
name: query-analytics
description: Query collected Uptimizr analytics via the collector read API — auth, params, filters, endpoints, and the pitfalls of aggregate responses. USE FOR: reading collected data, building a dashboard query, exploring heatmaps/sessions/perf, wiring an agent to the analytics, debugging an empty result. Trigger phrases: query the analytics, read collected data, call the query API, fetch a heatmap, get sessions, query endpoints.
---

# Skill: Query the analytics data

How to read collected analytics from the collector's HTTP **query API**. Use this when wiring a
dashboard panel, an agent, a notebook, or a one-off script against collected data — and when a
query comes back empty or wrong.

The authoritative endpoint reference is [docs/integration.md](../../../docs/integration.md)
§"HTTP API" → "Query (read)". This skill is the workflow and the gotchas; that table is the
contract. The request/response shapes are also encoded in
[oss/apps/collector-server/src/routes/query.ts](../../../oss/apps/collector-server/src/routes/query.ts)
(Zod querystrings) and mirrored client-side by the dashboard's `CollectorApi`
([oss/apps/dashboard/src/lib/api.ts](../../../oss/apps/dashboard/src/lib/api.ts)).

## 1. Auth & tenant scoping (read this first)

- Every read endpoint authenticates with a **project API key** in the `x-api-key` header.
- The project is resolved **from the key** server-side. Reads are always scoped to that project —
  any client-supplied project id is ignored, so a caller can only ever read its own data.
- No key / unknown key → `401`. There is no cross-project query; that boundary is by design
  (ADR 0003 privacy model, ADR 0009 ClickHouse tenant isolation). Do not add a `projectId` query
  param to "widen" a query — it will be ignored.

```bash
KEY=…   # a project API key
BASE=https://collect.example.com   # or http://localhost:8787 locally
curl -s -H "x-api-key: $KEY" "$BASE/api/v1/sessions?limit=20"
```

## 2. Shared params and filters

All endpoints accept a time range; binned/aggregate endpoints add binning and filters. These are
coerced and bounded by Zod at the edge — out-of-range values are rejected with `400`, not clamped.

- `since`, `until` — epoch **milliseconds**. Omit for the server default window.
- `bins` — bin count for binned heatmaps (1–500).
- `limit` — result cap (1–1000) on list/top endpoints.
- `cellSize` — voxel size in world units for world / click-ray heatmaps (positive, ≤ 1000).
- `interval` — bucket width in **seconds** for `timeseries`.
- `scene` — scope to one scene/area/level id (the value passed to `setScene` / `meta.sceneId`).
- `source` — input-source filter on pointer-based heatmaps: `mouse`, `touch`, `stylus`, `pen`,
  `xr-controller`, `hand`, `gaze`, `transient`, `other` (ADR 0011).
- `session` — scope an aggregate to a single session id.
- `type` — event-type filter on `timeseries` (lowercase/underscore event name).
- `format` — `full` | `table` | `summary`. Not a filter: it selects the result
  **envelope** (ADR 0051 §2). The HTTP endpoint defaults to `full`; the generated agent tools
  (`@uptimizr/agent-core`, `@uptimizr/mcp`) default to `table` and send it explicitly. `full` is
  the bare rows and never changes. `table` adds a `meta`
  envelope (metric, range, applied filters, sample size, row count, `truncated`, limits). `summary`
  returns a bounded digest capped at the metric's `maxSummaryRows` — ranked top rows, a
  first/last/min/max/trend series, or merged spatial clusters, with shares, a sample size, the
  registry caveats and a templated `reading` sentence. **Reach for `summary` first when you are an
  agent**: a 500-bin heatmap in `full` is thousands of tokens of nothing. Cluster coordinates are
  grid indices — multiply by the effective `cellSize`. `total`/`share` are `null` when the measure
  cannot honestly be summed (FPS, ratios, percentiles).

## 3. The endpoints (what to call)

Read the full table in docs/integration.md; the high-frequency ones:

| Need                           | Endpoint                                                              | Key extra params                                                                              |
| ------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Recent sessions                | `/api/v1/sessions`                                                    | `limit`                                                                                       |
| 2D pointer heatmap             | `/api/v1/heatmaps/pointer`                                            | `bins`, `scene`, `source`, `session`                                                          |
| 3D world-space pointer heatmap | `/api/v1/heatmaps/world`                                              | `cellSize`, `scene`, `source`                                                                 |
| View-direction (gaze) heatmap  | `/api/v1/heatmaps/camera`                                             | `bins`, `scene`, `session`                                                                    |
| View-gated click rays          | `/api/v1/heatmaps/click-rays`                                         | `cellSize`, `scene`, `source`, `session`                                                      |
| Gaze→mesh flow links           | `/api/v1/heatmaps/flow`                                               | `bins`, `limit`, `scene`, `session`, `cellSize`, `groupByOrigin`, `originVoxel`, `cameraMode` |
| Most-interacted meshes         | `/api/v1/meshes/top`                                                  | `limit`, `session`                                                                            |
| Rendering-performance summary  | `/api/v1/perf`                                                        | `session`                                                                                     |
| Scene picker (distinct scenes) | `/api/v1/scenes`                                                      | `limit`                                                                                       |
| Event volume over time         | `/api/v1/timeseries`                                                  | `scene`, `interval`, `type`                                                                   |
| Per-event-type counts          | `/api/v1/event-counts`                                                | `scene`                                                                                       |
| One session's descriptor       | `/api/v1/sessions/:id/meta`                                           | —                                                                                             |
| Registered scene proxies       | `/api/v1/scene-representations` / `/api/v1/scenes/:id/representation` | —                                                                                             |

## 4. Pitfalls (where queries go wrong)

- **Aggregate columns are JSON numbers — but `null` is not `0`.** Every store coerces numeric
  columns at the point rows leave its driver and every query route serialises through the metric
  registry's `row` schema (ADR 0051 §2), so `count()`, percentiles and sums arrive as numbers on
  DuckDB, ClickHouse, Postgres and SQL Server alike — do not re-parse them. What you do have to
  handle is `null`: a single-row summary (`/api/v1/perf`, `/api/v1/perf/jank`,
  `/api/v1/perf/resources`, …) is still returned over a range that matched nothing, with its
  aggregate columns `null`. That means "no samples", not zero — read the row's plain count first.
- **`since`/`until` are milliseconds, `interval` is seconds.** Mixing the units is the most common
  "empty result" cause. A `400` means a param failed Zod validation (e.g. `bins > 500`,
  negative `cellSize`, a `scene`/`source` that doesn't match the allowed pattern/enum).
- **Empty (200 + no rows) ≠ error.** It usually means the time window or `scene`/`session` filter
  excluded everything. Widen `since`/`until` and drop filters to confirm data exists, then narrow.
- **Raw per-session events are gated.** `/api/v1/sessions/:id/events` (the replay stream) returns
  `403` unless the collector runs with `ENABLE_RAW_SESSION_RETENTION` (ADR 0003). The aggregate
  endpoints never expose raw events — don't reach for the raw stream to build an aggregate.
- **No pagination beyond `limit`.** List endpoints cap at `limit` (≤ 1000); there are no cursors.
  Narrow with `since`/`until`/`scene` instead of paging.

## 5. Prefer the MCP server for agents

For an AI agent (or any MCP client) that should read analytics, use the read-only
[`@uptimizr/mcp`](../../../oss/packages/mcp/README.md) server instead of hand-rolling HTTP calls.
It wraps each read endpoint above as a typed, GET-only tool and is configured with
`UPTIMIZR_COLLECTOR_URL` + `UPTIMIZR_API_KEY`. It exposes **no** ingestion, mutation, or
raw-event tools — it is exactly the surface this skill describes, with the auth and unit pitfalls
handled for you (ADR 0017).

## 6. If you change the query surface

A new or changed query endpoint is a code change in `collector-server` + `db`, not just a skill
edit. Follow the `work-on-issue` skill and keep four things in lockstep:

1. the **metric registry**, `oss/packages/metrics/src/registry.ts` — the contract (see below),
2. the Zod querystring in `oss/apps/collector-server/src/routes/query.ts` (validate at the edge),
3. the **generated** tables — run `pnpm gen:docs` (after `pnpm build`) to re-render
   `docs/integration.md` §"Query (read)", the docs-site `api/query` page and the packaged
   `README`/`AGENTS.md`/`llms.txt` of `@uptimizr/mcp` and `@uptimizr/agent-core`; never hand-edit
   the text between their `generated:*` markers, and
4. the matching tool in `oss/packages/mcp` (so agents see it) and `CollectorApi` in the dashboard.

`GET /api/v1/openapi.json` and the MCP `uptimizr://capabilities` resource are generated from the
registry at runtime, so they need no follow-up edit — but check them when you change a row schema.

Then update this skill if the workflow or a gotcha changed, and run the validation gate
(`pnpm lint typecheck build test`).

### The registry is the contract (ADR 0051 §1)

`@uptimizr/metrics` holds one `MetricDefinition` per aggregation: its id (the same string the
agent tool uses), endpoint, result grain, group-by dimensions, accepted filters, the **output row
schema** (Zod), per-column units and semantics, row limits, how to interpret the result, the
caveats that make it untrustworthy, and the SDK capture channels (ADR 0012) that must be enabled
for it to have data. Read it before guessing what a column means — it is more precise than any
prose table, and it is what the generated tool catalog, OpenAPI document and docs tables will be
derived from.

Two CI gates keep it honest, so treat them as part of the definition of done:

- **A new aggregation is not done until it has a registry entry.** Add the `build*` name to
  `AGGREGATION_BUILDER_NAMES` in `oss/packages/metrics/src/registry.ts` and give it an entry;
  missing the entry is a compile error, `oss/packages/metrics/src/__tests__/registry.test.ts`
  re-checks coverage and consistency, and `oss/packages/db/src/__tests__/registry.test.ts` asserts
  the builder-name list still equals the real `build*` exports and parses every `row` schema
  against real DuckDB output.
- **An endpoint's querystring keys must equal its registry `filters`**, asserted by
  `oss/apps/collector-server/src/__tests__/registryRoutes.test.ts`. Adding a query parameter without
  declaring it in the registry fails the build.
- **The `row` schema is also the endpoint's response schema** (ADR 0051 §2). It is strict: a column
  the handler returns but the registry does not declare is stripped from the API, and a `null` in a
  column not declared nullable is a `500`. `queryResponseSchemas.test.ts` calls every registry
  endpoint against a seeded store, an empty one and the in-memory store to catch both. Numeric
  coercion belongs in the store runner (`coerceRows`), never back in the schema.
- **The committed docs tables must match the registry**, asserted by `pnpm gen:docs:check` in CI and
  by `oss/apps/collector-server/src/__tests__/genRegistryDocs.test.ts`. Run `pnpm gen:docs`.
