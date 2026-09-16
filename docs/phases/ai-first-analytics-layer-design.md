# Design sketch — AI-first analytics layer (ADR 0051)

> **Status:** Mutable design notes (not an ADR). The strategy, the trust-model amendment and the
> stage order are fixed in [ADR 0051](../adr/0051-ai-first-analytics-layer.md); this sketch holds
> the parts that are expected to be refined while they are built — the registry shape, the query
> DSL grammar, the insight algorithms, the subscription predicate format, the metadata tables, the
> evaluation harness. Durable choices that emerge here graduate to a new ADR (ADR 0016).

## How this doc is the map, and issues are the pieces (ADR 0016)

Every lettered section below is sized to become one or a few GitHub Issues under the
**"Agentic experience — AI-first layer (ADR 0051)"** milestone. §J lists the issue map with the
dependency order. Issues link back to their section here; this doc does not duplicate their task
lists.

## Design principles (carried from AGENTS.md / ADRs)

- **Events live once** (`@uptimizr/schema`). Nothing here adds an event type; every new capability
  is a query, a piece of metadata, or a transport.
- **Storage seam stays clean** (ADR 0020). New aggregations are dialect-authored in `@uptimizr/db`
  and parity-tested across DuckDB / Postgres / SQL Server / ClickHouse; new metadata is tables in
  the metadata layer, migrated per store (ADR 0007).
- **Thin backends** (ADR 0005). The collector validates at the edge, calls the store, and shapes
  the response. Statistics that cannot be expressed portably in SQL run as small, pure TypeScript
  functions in `@uptimizr/db` over portable aggregates — never in route handlers.
- **Trust boundary** (ADR 0051 §9). Events are read-only; aggregate by default; raw only behind
  `query:raw` + retention; metadata writes only behind `annotate`; bounded outputs everywhere; no
  Uptimizr-operated service.
- **One vocabulary.** The metric registry (§A) is the single source for names, dimensions,
  filters and units. The DSL, the insight endpoints, the context document, the subscriptions and
  the panel specs all speak registry names.

---

## A. Metric registry (ADR 0051 §1)

### A.1 Location and shape

`oss/packages/db/src/query/registry.ts`, next to `aggregations.ts`. One entry per `build*`
aggregation. The registry is data, not code: a `Readonly<Record<MetricId, MetricDefinition>>`.

```ts
export interface MetricDefinition {
  /** Stable id, snake_case; also the DSL `metric` name and the tool name. */
  id: MetricId; // e.g. "top_meshes", "perf_summary", "dead_clicks"
  title: string;
  description: string; // what it measures, one paragraph, agent-facing
  /** Which aggregation builder computes it (kept in sync by a type-level check). */
  builder: keyof typeof aggregations; // "buildTopMeshes"
  /** Collector route the canned endpoint lives on (if any). */
  endpoint?: { method: "GET"; path: string }; // "/api/v1/meshes/top"
  /** Result grain: what one row represents. */
  grain: "project" | "scene" | "session" | "mesh" | "bin" | "voxel" | "bucket" | "row";
  /** Group-by dimensions this metric can be broken down by (DSL `dimensions`). */
  dimensions: readonly DimensionId[]; // e.g. ["mesh", "source", "scene"]
  /** Filters accepted (DSL `filters`; also the endpoint querystring). */
  filters: readonly FilterId[]; // e.g. ["since", "until", "scene", "session", "cameraMode"]
  /** Output row schema — the single source for OpenAPI, tool output schema and coercion. */
  row: z.ZodObject<z.ZodRawShape>;
  /** Per-column semantics used by summaries, comparisons and the docs table. */
  columns: Readonly<Record<string, ColumnSemantics>>;
  /** Registry-declared caps so no consumer can request an unbounded payload. */
  limits: { maxRows: number; maxSummaryRows: number };
  /** How to read the result; small-sample and sampling-rate caveats. */
  interpretation: string;
  caveats: readonly string[];
  /** The dial that drives this metric (ADR 0012) so the context doc can warn when it is off. */
  sourceChannels: readonly EventType[]; // ["mesh_interaction"]
  related: readonly MetricId[];
  /** Comparison semantics for `compare`, `movers`, `anomalies`. */
  comparable?: {
    /** The column whose change is "the" change for this metric. */
    primary: string; // "interactions"
    /** Higher is better, lower is better, or neutral (informational). */
    direction: "up" | "down" | "neutral";
    /** Minimum denominator before a delta is reported as meaningful. */
    minSample: number;
  };
  /** Category used for grouping in docs, capabilities and the health score. */
  category:
    | "attention"
    | "interaction"
    | "navigation"
    | "performance"
    | "errors"
    | "xr"
    | "ar"
    | "sessions"
    | "conversion";
}

export interface ColumnSemantics {
  description: string;
  unit?:
    | "count"
    | "sessions"
    | "ms"
    | "s"
    | "fps"
    | "ratio"
    | "percent"
    | "world-units"
    | "radians"
    | "bytes"
    | "epoch-ms"
    | "id"
    | "label";
  /** For summaries: this column is the measure to rank by (one per metric). */
  measure?: boolean;
  /** For summaries: this column names the row (mesh, scene, bucket…). */
  label?: boolean;
  /** Denominator column when this column is a rate. */
  rateOf?: string;
}
```

`DimensionId` / `FilterId` are closed unions declared once and mapped to the option interfaces in
`types.ts` (`scene → SceneOptions.scene`, `source → SourceOptions.source`, …). Dimensions are
restricted to columns the store promotes (`scene_id`, `mesh`, `name`, `source`, `event_type`,
`device.*` from `session_start`, camera mode) so a group-by renders identically on every dialect.

### A.2 Generated consumers

| Consumer                                                  | Generation                                                                                                                                                                                        | Where                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `readTools` in `@uptimizr/agent-core`                     | `registryToTools(registry)`: input Zod shape from `filters`, `buildRequest` from `endpoint`, output schema from `row`. The 20 existing tool names are preserved as `id`s so no MCP client breaks. | `agent-core/src/tools.ts` becomes a thin call |
| `GET /api/v1/openapi.json`                                | Paths from `endpoint`, params from `filters`, responses from `row` (zod → JSON Schema)                                                                                                            | collector `routes/meta.ts`                    |
| MCP `uptimizr://capabilities`                             | The full registry serialised (minus `builder`)                                                                                                                                                    | `mcp/src/capabilities.ts`                     |
| `docs/integration.md` §Query table, docs site `api/query` | `scripts/gen-query-docs.mjs` renders the table; CI fails if the committed table is stale                                                                                                          | `scripts/`                                    |
| Packaged `AGENTS.md` / `llms.txt` tool sections           | Same generator, second template                                                                                                                                                                   | `mcp/`, `agent-core/`                         |

### A.3 CI checks

- Every exported `build*` in `aggregations.ts` has a registry entry (type-level via `builder`
  key, plus a runtime test that iterates the module's exports).
- Every registry `endpoint.path` is registered in `routes/query.ts` and its Zod querystring keys
  equal the registry `filters` (a test spins up the Fastify app and reads `printRoutes`/schemas).
- `row` parses the first row of each parity fixture result (ties the registry to real output).
- Committed generated artefacts (docs table, tool snapshot) match the generator output.

### A.4 Migration of the hand-written catalog

Stage 1 keeps `readTools` exported with the same names and input shapes. The generator is
introduced behind a snapshot test that asserts the generated catalog is a superset of the
hand-written one; then the hand-written array is deleted.

---

## B. Agent-shaped results (ADR 0051 §2)

### B.1 `format`

Shared querystring `format=full | table | summary` (default `full`; the dashboard is untouched).

- `table` — the same rows, numbers coerced, plus a `meta` envelope
  (`{ metric, rows, truncated, range, filters, sampleSize }`).
- `summary` — the envelope below, bounded by `limits.maxSummaryRows`.

```json
{
  "metric": "top_meshes",
  "range": { "since": 1757000000000, "until": 1757600000000 },
  "filters": { "scene": "lobby" },
  "sampleSize": { "sessions": 412, "events": 9130 },
  "total": 9130,
  "top": [
    {
      "label": "checkout_button",
      "value": 2210,
      "share": 0.242,
      "region": "counter",
      "nearestMesh": null
    },
    { "label": "door_left", "value": 1490, "share": 0.163 }
  ],
  "rest": { "rows": 61, "value": 5430, "share": 0.595 },
  "confidence": { "kind": "wilson", "level": 0.95, "note": "shares are proportions of events" },
  "reading": "Interaction concentrates on checkout_button (24%) and door_left (16%); the remaining 61 meshes share 60%.",
  "caveats": ["Only mesh_interaction events participate; hover is excluded unless enabled."]
}
```

`reading` is templated from `columns` semantics — no model involved. Metrics with a `bucket` grain
(time series) summarise as `{ first, last, min, max, trend: "up" | "down" | "flat", slope }`;
spatial grains summarise as clusters (§B.2).

### B.2 Spatial labelling and regions

- **Regions** extend the scene registry (ADR 0014): `scene_regions (project_id, scene_id,
region_id, label, bounds Aabb, updated_at)`, PK `(project_id, scene_id, region_id)`.
  Authoring: `PUT /api/v1/scenes/:sceneId/regions` (a `query`+`annotate` key), an SDK helper
  `registerRegions(scene, [{ id, label, bounds }])` next to `scanSceneProxy`, and the CLI.
  Regions may overlap; membership is "all regions containing the point", the smallest by volume
  is `region`.
- **Clustering** for `summary` on voxel/bin grains: greedy merge of adjacent occupied cells above
  a density threshold (8-neighbourhood for 2D bins, 26-neighbourhood for voxels), ranked by summed
  weight, capped at `maxSummaryRows`. Deterministic; no k-means seeds.
- **`nearestMesh`**: the proxy mesh (from the stored `SceneProxy` AABBs) whose box contains the
  cluster centroid, else the nearest box by centre distance within `cellSize × 2`; `distance` is
  reported so the agent can discount far matches. If no proxy is registered, `nearestMesh` is
  `null` and the summary says so in `caveats`.
- Labelling runs collector-side over the already-aggregated rows (cheap: ≤ a few thousand cells
  against ≤ a few thousand boxes); no store change.

### B.3 Numeric coercion

`@uptimizr/db` gains `coerceRows(metric, rows)` driven by `row` (any `z.number()` column with a
string value is parsed). Each store's runner applies it, so every client — dashboard, agent, CLI —
sees numbers. The `query-analytics` skill pitfall is deleted.

---

## C. Query DSL (ADR 0051 §3)

### C.1 Grammar (Zod, `@uptimizr/schema/query` so clients and the collector share it)

```ts
const queryV1 = z.object({
  v: z.literal(1),
  metric: MetricIdSchema,
  dimensions: z.array(DimensionIdSchema).max(3).optional(),
  filters: z
    .object({
      scene: sceneId.optional(),
      session: sessionId.optional(),
      source: inputSource.optional(),
      cameraMode: z.enum(["viewer", "first-person"]).optional(),
      mesh: meshName.optional(),
      region: regionId.optional(), // resolved to a RegionOptions AABB
      event: funnelStepSchema.optional(), // ADR 0038 predicate, for event-scoped metrics
      device: z
        .object({
          os: z.string().optional(),
          browser: z.string().optional(),
          gpuTier: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  range: z.object({ since: epochMs, until: epochMs }),
  segment: z.record(DimensionIdSchema, z.string()).optional(), // named slice for compare
  compare: z
    .union([
      z.object({ range: z.object({ since: epochMs, until: epochMs }) }),
      z.object({ segment: z.record(DimensionIdSchema, z.string()) }),
    ])
    .optional(),
  order: z.object({ by: z.string(), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  format: z.enum(["full", "table", "summary"]).default("table"),
  explain: z.boolean().default(false),
});
```

Validation beyond shape (a `superRefine`): `dimensions ⊆ registry[metric].dimensions`, `filters`
keys ⊆ `registry[metric].filters`, `compare.segment` keys ⊆ dimensions, `limit ≤ limits.maxRows`.

### C.2 Compilation

Two tiers, both through the existing `Dialect`:

1. **Delegated** (stage 2 default): the DSL maps to the metric's existing builder. `filters` map
   onto the builder's option interfaces via the registry's `FilterId → option` table; `dimensions`
   must equal the builder's native grain (e.g. `top_meshes` is already per-mesh). Every metric is
   reachable through the DSL on day one at exactly the canned endpoint's power.
2. **Generic group-by** (stage 2, second half): for metrics whose registry entry declares
   `genericGroupBy: true` (counts, rates, sums over promoted columns), a shared builder renders
   `SELECT <dims>, <measures> FROM events WHERE <filters> GROUP BY <dims>` so `dimensions` can be
   any registry-declared subset. Spatial and percentile metrics stay delegated.

`compare` runs the same spec twice (range or segment substituted) and joins on the dimension key
in TypeScript, emitting `{ current, previous, delta, deltaPct, significance? }` per row.
`explain` returns `{ sql: QuerySpec (dialect-rendered, params redacted), tier, rowsScanned?,
sampleSize, warnings[] }` where warnings include "below minSample", "channel disabled in this
project", "no proxy registered so no spatial labels".

`drill` is not a separate verb: it is the client issuing the same query with one more filter
(`region`, `mesh`, `scene`, a segment). The summary envelope includes `drill` hints listing the
filters that would narrow each top row.

### C.3 Transport and tool

- `POST /api/v1/query` with the JSON body; `GET /api/v1/query?q=<url-encoded JSON>` is accepted
  too so the GET-only collector client and simple MCP clients can use it. Both are reads; the
  `query` capability suffices.
- One tool, `query`, in the generated catalog, with the DSL as its input schema and the `table`
  format as default output. The canned per-metric tools remain for discoverability; `query` is
  what the skills and prompts recommend for anything with `compare` or `dimensions`.

---

## D. Insight primitives (ADR 0051 §4)

All are registry metrics (so they are tools, appear in OpenAPI, accept `format`) under
`/api/v1/insights/*`. Each is computed from **portable daily/hourly buckets** (the existing
`buildTimeseries` / `buildPerfDaily` / `buildEventsDaily` style) with the statistics in pure
TypeScript in `@uptimizr/db/src/insights/*.ts`, unit-tested with fixed inputs and parity-tested via
the buckets they consume. No per-dialect statistics SQL.

| Primitive      | Input                                                                  | Algorithm (v1)                                                                                                                                                                                                                                                                                                                                           | Output row                                                                                        |
| -------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `baseline`     | metric (comparable), scene?, `window` (days, default 28), bucket (day) | Per bucket series → mean, median, MAD, p10/p90, trend slope (least squares over bucket index)                                                                                                                                                                                                                                                            | `{ metric, scene, buckets, mean, median, mad, p10, p90, slope, sampleSize }`                      |
| `movers`       | scene?, `range` vs `reference` (default: previous equal window)        | For every comparable metric: delta of `primary`, gated by `minSample`; rank by robust z = delta / (MAD of the reference series + ε); return top N up and down                                                                                                                                                                                            | `{ metric, dimensionValue?, current, previous, delta, deltaPct, z, direction, aboveMinSample }`   |
| `anomalies`    | metric, scene?, `window`, bucket (hour/day), `sensitivity` (default 3) | Rolling median + MAD over the trailing window; bucket is anomalous if robust z > sensitivity. Change-points via CUSUM on the same series with threshold from MAD. Contributing dimension: re-run per dimension value if the metric has one dimension and pick the value with the largest share of the excess                                             | `{ metric, bucketStart, value, expected, z, kind: "spike" \| "drop" \| "shift", contributor? }`   |
| `significance` | metric, two segments or two ranges                                     | Rates (`rateOf` declared): two-proportion z-test with Wilson intervals. Means (`fps`, `ms`): Welch's t from per-bucket samples. Counts without denominator: Poisson rate test                                                                                                                                                                            | `{ metric, a, b, effect, ci95, p, test, powerNote }`                                              |
| `scene_health` | scene? (all scenes if omitted), `window`                               | Factors: perf stability (p05 fps vs project baseline), jank rate, error rate, dead+rage click rate, coverage %, XR abandonment (if XR events). Each normalised to 0–100 against the project baseline (§baseline) with declared weights; score is the weighted mean; every factor reports its raw value, its normalised score and the metric id behind it | `{ scene, score, factors: [{ id, metric, raw, score, weight, note }], sampleSize, since, until }` |

Weights and thresholds live in the registry entry for `scene_health` so they are visible in
capabilities and can be overridden per request (`weights` param) without code changes.

---

## E. Project context and metadata store (ADR 0051 §5)

### E.1 Context document — `GET /api/v1/context`, MCP `uptimizr://context`

```json
{
  "project": { "id": "…", "store": "duckdb", "schemaVersion": "…", "collectorVersion": "…" },
  "dataQuality": {
    "lastEventAt": 1757600000000,
    "sessions24h": 91,
    "events24h": 18023,
    "retention": { "rawSessions": false }
  },
  "capture": {
    "channels": {
      "camera_sample": { "seen": true, "approxHz": 1 },
      "mesh_visibility": { "seen": false }
    }
  },
  "scenes": [
    {
      "id": "lobby",
      "label": "Lobby",
      "regions": [{ "id": "counter", "label": "Checkout counter" }],
      "proxy": true,
      "sessions28d": 1204
    }
  ],
  "vocabulary": {
    "customEvents": [
      { "name": "add_to_cart", "count28d": 311, "props": { "sku": "string", "qty": "number" } }
    ],
    "meshes": { "count": 63, "top": ["checkout_button", "door_left"] },
    "inputActions": ["jump", "sprint"]
  },
  "definitions": {
    "funnels": [],
    "segments": [],
    "glossary": [{ "term": "btn_01", "meaning": "the buy button" }]
  },
  "annotations": {
    "recent": [
      {
        "id": "…",
        "target": { "kind": "scene", "id": "lobby" },
        "text": "Launch of v2 lobby",
        "at": 1757400000000
      }
    ]
  },
  "metrics": { "available": ["top_meshes", "…"], "disabledByCapture": ["mesh_dwell"] }
}
```

`capture.channels` is derived from `event_counts` over the window (a channel is "seen" when its
event type has rows) — no SDK change. `vocabulary.customEvents` is a new aggregation
`buildCustomEventVocabulary` (distinct `name`, count, and the union of observed prop keys with a
coarse type per key, sampled from the last N rows to bound cost).

The assistant injects a compact rendering of this document into the system prompt on session start
and refreshes it when the project or range changes; the `weekly_scene_health` and other prompts
tell agents to read `uptimizr://context` first.

### E.2 Metadata tables (per store migration, ADR 0007)

| Table            | Columns                                                                                                                                                                               | Notes                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `annotations`    | `id, project_id, target_kind (project\|scene\|mesh\|region\|metric\|window), target_id, since?, until?, text (≤2k), author_kind (user\|agent), author_key_id, created_at, updated_at` | Shown on dashboard time axes and in context |
| `glossary`       | `project_id, term, meaning (≤500), updated_at`                                                                                                                                        | PK `(project_id, term)`                     |
| `saved_analyses` | `id, project_id, title, query (DSL JSON), conclusion (≤4k), author_kind, author_key_id, created_at`                                                                                   | Re-runnable; the context lists titles + ids |
| `panel_specs`    | `id, project_id, spec (PanelSpec JSON), created_at, updated_at`                                                                                                                       | §G.3                                        |
| `scene_regions`  | see §B.2                                                                                                                                                                              |                                             |
| `subscriptions`  | see §F.1                                                                                                                                                                              |                                             |
| `agent_audit`    | see §G.2                                                                                                                                                                              |                                             |

Endpoints: `GET/POST/DELETE /api/v1/annotations`, `GET/PUT/DELETE /api/v1/glossary/:term`,
`GET/POST/DELETE /api/v1/analyses`, `GET/POST/DELETE /api/v1/panels`. Writes require `annotate`;
reads require `query`. Payload sizes are bounded by Zod at the edge. MCP tools mirror them
(`annotate`, `save_analysis`, `define_term`, `pin_panel`) and are registered only when the key's
capabilities include `annotate` (the server checks once at start-up via `GET /api/v1/whoami`).

---

## F. Subscriptions, webhooks, scheduled reports (ADR 0051 §6)

### F.1 Subscription record and predicate

```json
{
  "id": "sub_…",
  "projectId": "…",
  "name": "FPS drop in lobby",
  "metric": "perf_summary",
  "filters": { "scene": "lobby" },
  "evaluate": { "every": "5m", "window": "15m" },
  "predicate": {
    "kind": "threshold",
    "column": "p50_fps",
    "op": "<",
    "value": 30,
    "minSample": 20
  },
  "cooldown": "1h",
  "delivery": [{ "kind": "webhook", "url": "https://…", "secret": "…" }, { "kind": "sse" }],
  "enabled": true
}
```

Predicate kinds (closed union): `threshold` (column op value), `anomaly` (delegates to §D
`anomalies` with `sensitivity`), `movers` (delta of `primary` beyond `pct` vs the previous window),
`new_value` (a dimension value never seen before — "new scene", "new custom event"),
`presence` (active sessions above/below N, evaluated on the live bus without a store query).

### F.2 Evaluation model

- **Store-backed predicates** run on a timer per subscription (`evaluate.every`, min 1 minute),
  issuing the registry query for `window`; a single in-process scheduler in the collector with a
  cap on concurrent evaluations. This keeps the live bus untouched for the heavy cases.
- **Bus-backed predicates** (`presence`, `new_value` on promoted columns) subscribe to the live
  bus (`LiveBus.subscribe`) and evaluate per event with a bounded per-subscription state.
- **Firing** writes a `subscription_events` row `{ subscriptionId, at, payload }` (bounded
  retention: last 100 per subscription), honours `cooldown`, then delivers.

### F.3 Delivery

- **SSE:** `GET /api/v1/subscriptions/stream?token=…` (live-token model of ADR 0032 §7) emits
  `subscription` events for all of the project's subscriptions; per-id filtering via query param.
- **Webhook:** `POST` with `X-Uptimizr-Signature: sha256=HMAC(secret, body)` and
  `X-Uptimizr-Delivery` id; 3 retries with backoff; failures recorded on the subscription. Payload
  = the firing record + a `summary`-format result of the metric so the receiver (Slack, an agent,
  a GitHub Action) can act without a second call.
- No outbound egress happens unless a self-hoster configures a webhook URL.

### F.4 `uptimizr agent report`

A subcommand in `collector-server/src/cli.ts`:

```bash
UPTIMIZR_COLLECTOR_URL=… UPTIMIZR_API_KEY=… \
UPTIMIZR_AGENT_PROVIDER=anthropic UPTIMIZR_AGENT_MODEL=… UPTIMIZR_AGENT_API_KEY=… \
uptimizr agent report --skill weekly_scene_health --scene lobby --out report.md --webhook https://…
```

Runs `runAgent` from `@uptimizr/agent-core` with the hosted provider adapter (`providers/hosted`)
against the local collector, seeds the transcript with the chosen packaged skill (§G.4) and the
context document (§E.1), and writes Markdown to a file, stdout or a webhook. Scheduling is the
operator's cron / systemd timer / GitHub Actions — the collector gains no in-process LLM loop
(thin backends). Provider configuration is read from env only, never persisted.

---

## G. Reach, identity, artifacts (ADR 0051 §7)

### G.1 Collector-hosted MCP over Streamable HTTP

- Route `/mcp` in `collector-server` using `@modelcontextprotocol/sdk`'s Streamable HTTP server
  transport, registered behind `COLLECTOR_MCP_HTTP=1` (off by default).
- Auth: `x-api-key` on every request (the MCP `Authorization: Bearer` header is accepted as an
  alias). The key resolves to `{ projectId, capabilities }`; a `CollectorClient` is built per MCP
  session bound to that key and an in-process base URL, and `createMcpServer(client)` from
  `@uptimizr/mcp` is reused unchanged (`@uptimizr/mcp` becomes a dependency of the collector).
- Sessions are stateless-per-request where the SDK allows; connection cap and rate limit reuse the
  live-connection and query rate-limit config.
- The stdio package remains for local clients and the demo.

### G.2 Key capabilities, rate limits, audit

- `ApiKeyCapability` becomes a set: `capabilities: ("ingest" | "query" | "annotate" | "query:raw")[]`
  (migration: existing `capability` column → array with one element). `query:raw` is honoured only
  when `ENABLE_RAW_SESSION_RETENTION` is on.
- CLI: `uptimizr new-key --capabilities query,annotate --label "weekly-report-agent"`.
- Per-key rate limit (`rate_limit_max`, `rate_limit_window_ms`, nullable → global default).
- `agent_audit (id, project_id, key_id, at, surface (http|mcp-stdio|mcp-http|assistant), tool_or_path,
params (JSON, bounded), row_count, duration_ms, status)`; written for every read and write on a
  key that is not the dashboard's own session; `GET /api/v1/audit` (query capability) with range
  filters; retention `AUDIT_RETENTION_DAYS` (default 30).
- **Session narrative** (`query:raw`): `GET /api/v1/sessions/:id/narrative` — an ordered, compacted
  account built from the raw stream: scene changes, dwell per mesh above N ms, interactions,
  perf dips, errors, with timestamps relative to session start; bounded to `maxRows`. Exposed as
  a tool only when the key holds `query:raw`.

### G.3 Declarative panel specs

```ts
const panelSpecV1 = z.object({
  v: z.literal(1),
  title: z.string().max(120),
  query: queryV1, // §C.1, `range` may be "inherit" to follow the filter bar
  chart: z.enum(["stat", "table", "bar", "line", "area", "heatmap2d", "world3d"]),
  encoding: z
    .object({ x: z.string().optional(), y: z.string().optional(), series: z.string().optional() })
    .optional(),
  span: z.union([z.literal(1), z.literal(2)]).default(1),
  note: z.string().max(500).optional(), // the agent's one-line reading, shown as subtitle
});
```

`@uptimizr/react` gains one generic `specPanel(spec)` factory that returns a `PanelDefinition`
(ADR 0036) rendering the chosen chart from the query result via the existing catalog primitives.
The dashboard loads `GET /api/v1/panels` on mount and merges them with `builtinPanels` (ids
prefixed `spec:`), and the assistant gets a "Pin as panel" action on any answer that came from a
`query` call. No remote code is loaded (ADR 0041's trust decision is not widened).

### G.4 Packaged skills

`oss/packages/agent-core/skills/<name>/SKILL.md` (Agent Skills format: frontmatter `name`,
`description`, then the methodology), shipped in the tarballs of `@uptimizr/agent-core` and
`@uptimizr/mcp` and exposed as MCP prompts that embed the skill text. Initial set:
`weekly-scene-health`, `attention-hotspots`, `conversion-investigation`, `performance-regression-triage`,
`xr-comfort-audit`. Each names the registry metrics, insight primitives and DSL patterns to use,
and the caveats to report.

---

## H. Evaluation harness (ADR 0051 §8)

- Package `oss/packages/agent-eval` (private, not published): a **question bank**
  (`cases/*.yaml`: `question`, `expectedTools` (any-of sets), `expectedArgs` (subset match),
  `expectedAnswer` (numeric tolerance or required phrases), `context` (scene/range)), a **runner**
  that seeds the parity fixtures into the in-memory store, boots the collector `app` in-process,
  runs `runAgent` with a provider, and scores each case, and a **report** (Markdown + JSON).
- Providers: hosted (Anthropic / OpenAI-compatible via `providers/hosted`, key from a CI secret,
  runs on PRs touching `agent-core`, `mcp`, `db/src/query`, `react/src/assistant`); local WebLLM
  models on a weekly scheduled job in a headless browser (Playwright) since they need WebGPU.
- Scores are tracked per case; a PR fails the gate when the hosted pass rate drops below the
  committed baseline (`eval/baseline.json`) by more than a tolerance.
- The bank starts with ~40 cases spanning every registry category and the three skills that ship
  first; every new metric adds at least one case (CI check, like the registry coverage test).

---

## I. Open questions (resolve while building; promote to an ADR if hard to reverse)

1. **Generic group-by scope** — which metrics get `genericGroupBy` in stage 2 versus stay
   delegated; the answer decides how much of the DSL's `dimensions` power lands early.
2. **Insight statistics in SQL vs TypeScript** — the sketch puts statistics in TS over portable
   buckets; if DuckDB/ClickHouse window functions make a pure-SQL path cheap for anomalies, revisit
   for performance on large windows.
3. **Capability array migration** — one-shot column → array migration on four stores; confirm
   SQL Server JSON handling for the array column.
4. **MCP HTTP session model** — stateless per request vs SDK-managed sessions; depends on the
   SDK version's Streamable HTTP maturity at build time.
5. **Regions authoring UX** — SDK helper only, or also a dashboard "draw a box" tool (would be the
   first authoring surface in the OSS dashboard, touching the ADR 0038 stance).

---

## J. Issue map (the moving pieces)

Each row is one issue in the milestone (epic: [#294](https://github.com/RaananW/Uptimizr/issues/294)). "Depends on" is a hard
order; rows without one can run in parallel within their stage.

| Issue                                                  | Stage | Title                                                                                      | Section | Depends on       |
| ------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------ | ------- | ---------------- |
| [#294](https://github.com/RaananW/Uptimizr/issues/294) | —     | Epic: AI-first analytics layer (ADR 0051)                                                  | all     | —                |
| [#295](https://github.com/RaananW/Uptimizr/issues/295) | 1     | Metric registry in `@uptimizr/db` with CI coverage checks                                  | A       | —                |
| [#296](https://github.com/RaananW/Uptimizr/issues/296) | 1     | Generate the `readTools` catalog from the registry (68/68, names preserved)                | A.2/A.4 | #295             |
| [#297](https://github.com/RaananW/Uptimizr/issues/297) | 1     | Serve OpenAPI, and generate capabilities, docs table, AGENTS.md/llms.txt from the registry | A.2     | #295             |
| [#298](https://github.com/RaananW/Uptimizr/issues/298) | 1     | Output row schemas + numeric coercion at every store's edge                                | A.1/B.3 | #295             |
| [#299](https://github.com/RaananW/Uptimizr/issues/299) | 1     | `format=table\|summary` envelope on aggregate endpoints                                    | B.1     | #298             |
| [#300](https://github.com/RaananW/Uptimizr/issues/300) | 1     | Evaluation harness package + CI gate                                                       | H       | #296             |
| [#301](https://github.com/RaananW/Uptimizr/issues/301) | 2     | Scene regions: registry table, endpoint, SDK helper, CLI                                   | B.2     | —                |
| [#302](https://github.com/RaananW/Uptimizr/issues/302) | 2     | Spatial labelling (`nearestMesh`, `region`) on spatial summaries                           | B.2     | #299, #301       |
| [#303](https://github.com/RaananW/Uptimizr/issues/303) | 2     | Query DSL v1: schema, delegated compiler, `POST/GET /api/v1/query`, `query` tool           | C       | #296, #298       |
| [#304](https://github.com/RaananW/Uptimizr/issues/304) | 2     | DSL `compare`, `explain`, drill hints, generic group-by tier                               | C.2     | #303             |
| [#305](https://github.com/RaananW/Uptimizr/issues/305) | 2     | Insight primitives: `baseline` and `movers`                                                | D       | #298             |
| [#306](https://github.com/RaananW/Uptimizr/issues/306) | 2     | Insight primitive: `anomalies` (robust z + CUSUM, contributor)                             | D       | #305             |
| [#307](https://github.com/RaananW/Uptimizr/issues/307) | 2     | Insight primitives: `significance` and `scene_health`                                      | D       | #305             |
| [#308](https://github.com/RaananW/Uptimizr/issues/308) | 2     | Project context resource + custom-event vocabulary + assistant prompt injection            | E.1     | #301             |
| [#309](https://github.com/RaananW/Uptimizr/issues/309) | 3     | Key capability set (`annotate`, `query:raw`), per-key rate limits, audit log               | G.2     | —                |
| [#310](https://github.com/RaananW/Uptimizr/issues/310) | 3     | Metadata write path: annotations, glossary, saved analyses (+ MCP tools, assistant)        | E.2     | #309             |
| [#311](https://github.com/RaananW/Uptimizr/issues/311) | 3     | Conditional subscriptions, SSE stream, signed webhooks                                     | F.1–F.3 | #305, #306, #309 |
| [#312](https://github.com/RaananW/Uptimizr/issues/312) | 3     | `uptimizr agent report` CLI (headless scheduled reports)                                   | F.4     | #308             |
| [#313](https://github.com/RaananW/Uptimizr/issues/313) | 3     | Collector-hosted MCP over Streamable HTTP (`/mcp`)                                         | G.1     | #309             |
| [#314](https://github.com/RaananW/Uptimizr/issues/314) | 3     | Session narrative under `query:raw`                                                        | G.2     | #309             |
| [#315](https://github.com/RaananW/Uptimizr/issues/315) | 3     | Declarative `PanelSpec`, generic spec panel, "Pin as panel"                                | G.3     | #303, #310       |
| [#316](https://github.com/RaananW/Uptimizr/issues/316) | 3     | Packaged methodology skills + "Building agents on Uptimizr" docs guide                     | G.4     | #303, #305       |
