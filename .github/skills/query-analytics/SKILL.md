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

## 3. The endpoints (what to call)

Read the full table in docs/integration.md; the high-frequency ones:

| Need                           | Endpoint                                                              | Key extra params                         |
| ------------------------------ | --------------------------------------------------------------------- | ---------------------------------------- |
| Recent sessions                | `/api/v1/sessions`                                                    | `limit`                                  |
| 2D pointer heatmap             | `/api/v1/heatmaps/pointer`                                            | `bins`, `scene`, `source`, `session`     |
| 3D world-space pointer heatmap | `/api/v1/heatmaps/world`                                              | `cellSize`, `scene`, `source`            |
| View-direction (gaze) heatmap  | `/api/v1/heatmaps/camera`                                             | `bins`, `scene`, `session`               |
| View-gated click rays          | `/api/v1/heatmaps/click-rays`                                         | `cellSize`, `scene`, `source`, `session` |
| Gaze→mesh flow links           | `/api/v1/heatmaps/flow`                                               | `bins`, `limit`, `scene`, `session`, `cellSize`, `groupByOrigin`, `originVoxel`, `cameraMode` |
| Most-interacted meshes         | `/api/v1/meshes/top`                                                  | `limit`, `session`                       |
| Rendering-performance summary  | `/api/v1/perf`                                                        | `session`                                |
| Scene picker (distinct scenes) | `/api/v1/scenes`                                                      | `limit`                                  |
| Event volume over time         | `/api/v1/timeseries`                                                  | `scene`, `interval`, `type`              |
| Per-event-type counts          | `/api/v1/event-counts`                                                | `scene`                                  |
| One session's descriptor       | `/api/v1/sessions/:id/meta`                                           | —                                        |
| Registered scene proxies       | `/api/v1/scene-representations` / `/api/v1/scenes/:id/representation` | —                                        |

## 4. Pitfalls (where queries go wrong)

- **Aggregate columns come back as JSON strings.** ClickHouse returns `count()` and similar as
  strings (e.g. `"42"`). Coerce to numbers on the client before doing math. The dashboard's
  `CollectorApi` already does this — mirror it; don't sum strings.
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
edit. Follow the `work-on-issue` skill and keep three things in lockstep:

1. the Zod querystring in `oss/apps/collector-server/src/routes/query.ts` (validate at the edge),
2. the table in `docs/integration.md` §"Query (read)" (the contract), and
3. the matching tool in `oss/packages/mcp` (so agents see it) and `CollectorApi` in the dashboard.

Then update this skill if the workflow or a gotcha changed, and run the validation gate
(`pnpm lint typecheck build test`).
