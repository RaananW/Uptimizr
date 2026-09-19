# @uptimizr/db-postgres

## 2.1.0

### Minor Changes

- 395aa36: Add the **metadata write path** — annotations, a project glossary and saved analyses — so people
  and agents can leave something behind instead of re-deriving it every session. Events stay
  read-only; these are the only rows a request can write besides ingestion, and every write needs a
  key holding the `annotate` capability and is recorded in the agent audit log (ADR 0051 §5/§9).

  - `@uptimizr/schema`: `annotationSchema` (`targetKind: project|scene|mesh|region|metric|window`,
    optional `targetId`, `since`/`until`, bounded `text`), `glossaryEntrySchema`,
    `savedAnalysisSchema` and `metadataAuthorKindSchema` — config/metadata shapes, deliberately
    outside the event union — plus the per-field and per-project bounds in `LIMITS`.
  - `@uptimizr/db` and the optional Postgres / SQL Server / ClickHouse stores: `annotations`,
    `glossary` and `saved_analyses` tables (forward-only, idempotent migrations) with
    `createAnnotation` / `listAnnotations` / `deleteAnnotation`, `putGlossaryEntry` / `listGlossary` /
    `deleteGlossaryEntry` and `createSavedAnalysis` / `listSavedAnalyses` / `deleteSavedAnalysis`.
    Each store enforces the per-project caps (500 annotations, 200 glossary terms, 200 analyses) at
    write time and throws `MetadataLimitError` when a project is full.
  - `@uptimizr/collector-server`: `GET`/`POST`/`DELETE /api/v1/annotations[/:id]`,
    `GET /api/v1/glossary` with `PUT`/`DELETE /api/v1/glossary/:term`, and
    `GET`/`POST`/`DELETE /api/v1/analyses[/:id]`. Writes require `annotate`, reads `query`; payloads
    are Zod-bounded at the edge and a full project answers `409`. Stored rows record whether a person
    or an agent wrote them, decided from the calling client rather than the payload. The served
    OpenAPI document describes the whole group.
  - `@uptimizr/agent-core` and `@uptimizr/mcp`: a new `writeTools` catalog (`annotate`, `define_term`,
    `save_analysis`, plus `list_annotations`, `list_glossary`, `list_analyses`), kept a **separate
    export** from the read-only `readTools` so an integration's read-only stance stays inspectable.
    The MCP server calls `GET /api/v1/whoami` at start-up and registers them only when the key holds
    `annotate`; the collector client gains `post`/`put`/`delete` used by these tools alone.
  - `@uptimizr/react`: `CollectorApi.whoami` / `.annotations` / `.createAnnotation` / `.glossary` /
    `.defineTerm` / `.analyses` / `.saveAnalysis`, the assistant actions "Annotate this" and "Save
    this analysis" (shown only for an `annotate` key), `annotationTargetFor(filters)`, and annotation
    markers on the event-volume time axis.
  - `@uptimizr/dashboard`: the assistant drawer passes the active filters through, so an
    "Annotate this" note is pinned to the scene or window the user is looking at.

- 395aa36: **Query DSL stage 2** (ADR 0051 §3, #304): `compare`, `explain`, runnable drill hints, `order`,
  `segment` and a **generic group-by tier** — the four fields the v1 grammar published and answered
  with `400 … not supported yet` now execute.

  **The grain is registry data.** `MetricDefinition` gains a required `grainDimensions` (what one row
  is keyed by, read through `nativeDimensions`) and an optional `genericGroupBy`. The grain used to be
  derived from `row.shape` at call time, which was correct but left the registry unable to distinguish
  "this metric cannot be grouped by that" from "it can, through another compiler". The old derivation
  survives as the gate on the declaration.

  **A second compiler, not a second SQL path.** Seven metrics whose measure is a portable count or sum
  over promoted columns — `event_counts`, `top_meshes`, `mesh_sources`, `mesh_interaction_kinds`,
  `interaction_sources`, `top_input_actions`, `camera_gestures` — declare `genericGroupBy` and can be
  recomputed at any grain they declare by one shared, dialect-authored builder. Everything variable in
  its SQL comes from registry data; every caller-supplied value is a bound parameter. Spatial and
  percentile metrics have no generic tier and keep refusing a non-grain `dimensions` by name. Six
  `dsl:generic*` parity cases execute the generic SQL on DuckDB, Postgres, SQL Server and ClickHouse
  against the same hand-verified goldens.

  **`compare`** runs the same validated spec twice — the comparison's `range`, or its `segment`,
  substituted — and joins the two results in TypeScript on the dimension key, so every row is
  `{ key, label, current, previous, delta, deltaPct }` and a key present on one side only is still a
  row. `significance` is attached only where the registry justifies it: a pooled two-proportion _z_
  with Wilson intervals when the measure is a count and both windows clear the metric's `minSample`,
  Welch's _t_ over a `bucket`-grain metric's per-bucket values, and **absent** for a mean-shaped
  measure, with a caveat saying why. `format=summary` digests it into ranked movers with a templated
  reading.

  **`explain: true`** answers with the plan instead of the rows: the tier, the store's dialect, the
  rendered SQL with its parameters left unbound, `params` by name and logical type (never value),
  `rowsScanned`, and `warnings` for a capture channel that produced nothing in the window, a sample
  below the metric's own minimum, a spatial result with no proxy or regions to name hotspots after,
  and truncation by `limit`. Stores gain one method, `describeMetric`, which compiles without running.

  **Drill hints are runnable.** Every ranked summary row now carries `drillQuery` — the whole query,
  narrowed to that row — using `filters` where the metric has one and `segment` where it has not, so
  following a drill-down is a copy-paste rather than a reconstruction.

  **`order`** is honoured in SQL on the generic tier and applied to a delegated ranked result
  afterwards, with a caveat when the builder's own row cap had already chosen which rows exist.
  `filters.event` (an ADR 0038 predicate, applied as a cohort of sessions) and `filters.device`
  (`os` / `browser` on `session_start`) are generic-tier only. `queryDimensionIdSchema` now admits
  `camelCase`, so `cameraMode` is nameable as a dimension.

  The `query` tool's description gains one line each for `compare`, `explain` and `drillQuery` — the
  three things a model otherwise does badly in prose.

- 395aa36: Conditional subscriptions, an SSE stream and signed webhooks (ADR 0051 §6). A subscription names a
  registry metric, a window and a predicate — `threshold`, `anomaly`, `movers`, `new_value` or
  `presence` — and the collector evaluates it in-process on a bounded scheduler, records each firing
  in a per-subscription log and delivers it over SSE and/or an HMAC-signed webhook. Webhook egress is
  disabled until `COLLECTOR_WEBHOOK_ALLOWED_HOSTS` names the hosts the collector may reach, and a
  webhook secret is write-only. Adds `/api/v1/subscriptions*`, a read-only dashboard panel, a
  `list_subscriptions` agent tool and `uptimizr subscriptions list|add|remove|test`.

### Patch Changes

- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [0c7507d]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [e1213c8]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [395aa36]
- Updated dependencies [785761d]
- Updated dependencies [395aa36]
- Updated dependencies [969c899]
- Updated dependencies [395aa36]
  - @uptimizr/db@2.1.0
  - @uptimizr/schema@1.2.0

## 2.0.2

### Patch Changes

- Updated dependencies [3215c56]
  - @uptimizr/db@2.0.1

## 2.0.1

### Patch Changes

- 1123bfe: Ship AGENTS.md and llms.txt in the tarball (ADR 0017)

## 2.0.0

### Major Changes

- a6d87b1: Agent-scoped API keys: capability sets, per-key rate limits, an audit log and `whoami` (#309, ADR 0051 §7).

  **Breaking — raw per-session access now needs `query:raw`.** `GET /api/v1/sessions/:id/events` and the live per-session follow `GET /api/v1/live/sessions/:id` require **both** `ENABLE_RAW_SESSION_RETENTION` on the collector and the new `query:raw` capability on the key; previously retention alone was enough for any `query` key. Existing keys keep working for every aggregate endpoint and need no migration, but a key that drives session replay or live-follow must be re-minted with `uptimizr new-key <projectId> --capabilities query,query:raw`.

  **Breaking — `@uptimizr/db` metadata contracts.** `ApiKeyCapability` grows from `"ingest" | "query"` to `"ingest" | "query" | "annotate" | "query:raw"`. `ApiKeyRecord` and `ResolvedApiKey` replace the singular `capability` field with `capabilities: ApiKeyCapability[]`, and gain `label` plus a nullable `rateLimit`; `ResolvedApiKey` also carries `keyId`. `createApiKey(client, projectId, capability?)` now takes an options object (`{ capabilities, label, rateLimit }`) on all four engines. Each store package gains `recordAudit` / `listAudit` / `pruneAudit`.

  - Migrations on DuckDB, Postgres, SQL Server and ClickHouse add `capabilities`, `label`, `rate_limit_max`, `rate_limit_window_ms` and an `agent_audit` table. They are forward-only, additive and idempotent (ADR 0007); the legacy `capability` column is untouched and still feeds the read path as a fallback, so keys issued before this release resolve unchanged.
  - Per-key rate limits (`uptimizr new-key --rate-limit-max N --rate-limit-window-ms M`) bucket on the key id instead of the client IP; keys without one keep the global `COLLECTOR_RATE_LIMIT_*` defaults. Keyless ingest is unaffected.
  - `GET /api/v1/whoami` reports the calling key's project, key id, capabilities, label and effective rate limit. `GET /api/v1/audit` (`since`/`until`/`limit`, `query` capability) serves the agent audit trail: key id, route pattern, bounded and redacted params, row count, duration and status, written asynchronously and expiring after `AUDIT_RETENTION_DAYS` (default 30).
  - New CLI: `uptimizr new-key <projectId> [--capabilities …] [--label …] [--rate-limit-max N --rate-limit-window-ms M]`. `init` and `new-project` keep minting read-only `query` keys; `uptimizr-db-new-project` gains a `--capabilities` flag.
  - `@uptimizr/react`'s `CollectorApi` takes an optional third `client` argument (default `"dashboard"`) and sends it as `x-uptimizr-client`, which is how the collector tells a dashboard's panel refreshes apart from agent traffic in the audit log. Existing two-argument construction is unchanged.

### Minor Changes

- 2f1a753: Add **scene regions** — named, labelled world-space boxes that give a scene a shared vocabulary
  for _where_ things happen ("the entrance", "the checkout counter").

  - `@uptimizr/schema`: `sceneRegionSchema` / `sceneRegionsSchema` (config, deliberately outside the
    event union) plus the `maxSceneRegionLabelLength` / `maxSceneRegionDescriptionLength` /
    `maxSceneRegions` bounds.
  - `@uptimizr/db` and the optional Postgres / SQL Server / ClickHouse stores: a `scene_regions`
    metadata table (forward-only, idempotent migration) keyed `(project_id, scene_id, region_id)`,
    with `putSceneRegions` (replaces a scene's whole set atomically), `getSceneRegions` and
    `listSceneRegions`.
  - `@uptimizr/collector-server`: `PUT` / `GET /api/v1/scenes/:sceneId/regions`, the project-wide
    `GET /api/v1/scene-regions` listing, `uptimizr regions set|get` CLI commands, and `region=<id>`
    as an alternative to the six-number box on every spatial endpoint that already takes a region
    (resolved server-side to the stored bounds; an unregistered id is a `400`). The region reads
    take a `query`-capable key; the **write** takes an `annotate`-capable one (a `query`-only key
    is refused with `403`). `uptimizr regions set` opens the store directly and needs no key.
  - `@uptimizr/sdk-core`: `registerRegions(sceneId, regions, { endpoint, apiKey })`, the authoring
    counterpart to a connector's `scanSceneProxy`.

- ee1b7c7: Coerce numeric columns at every store's edge, so the collector always emits numbers (ADR 0051 §2).

  `@uptimizr/db` gains `coerceRows(metric, rows)`, driven by the metric registry's `row` schema, plus
  `numericColumns` / `numericColumnsOfMetric`; `@uptimizr/metrics` gains the `METRIC_BY_BUILDER`
  reverse lookup behind `metricForBuilder` (pure registry data, so it lives with the registry). Every
  `build*` aggregation now tags its `QuerySpec` with the registry metric id (`QuerySpec.metric`), and
  `runDuckdbQuery`, `runClickhouseQuery`, `runPostgresQuery` and `runMssqlQuery` each apply the
  coercion at the single point rows leave their driver — so a 64-bit integer or decimal that
  ClickHouse renders as `"42"` over HTTP, or an `int8` that `pg` hands back as a string, reaches every
  consumer as a number. `null` is preserved: an aggregate over an empty set means "no samples", never
  `0`. A value that is neither a number, `null`, nor a finite numeric string throws under a test
  runner and is left untouched with a one-per-column warning in production.

  Because the coercion now happens at the edge, the registry's numeric columns are strict `z.number()`
  rather than `z.coerce.number()`, and the collector's query routes carry those schemas as Fastify 200
  response schemas. Tightening the schemas exposed that nine perf/resource metrics can legitimately
  return `null` — SQL aggregates are NULL over an empty set, and a single-row summary is still
  returned when the range matched nothing — so `perf_summary`, `perf_distribution`,
  `frame_time_percentiles`, `jank_rate`, `perf_churn`, `render_scale_truth`, `resource_summary`,
  `resource_percentiles` and `dead_clicks` now declare those columns nullable. Previously
  `z.coerce.number()` silently reported them as `0`; consumers that treated `0` as "measured zero"
  should now read `null` as "no data". Cross-engine parity asserts `typeof === "number"` for every
  registry-numeric column on DuckDB, ClickHouse, Postgres and SQL Server.

### Patch Changes

- Updated dependencies [a6d87b1]
- Updated dependencies [fa489c1]
- Updated dependencies [d1d8f7c]
- Updated dependencies [e378214]
- Updated dependencies [2f1a753]
- Updated dependencies [ee1b7c7]
  - @uptimizr/db@2.0.0
  - @uptimizr/schema@1.1.0

## 1.0.2

### Patch Changes

- 3c3ee66: Make the package scripts cross-platform so a fresh Windows checkout can build. `clean` now uses `rimraf` instead of `rm -rf`, and the dashboard's `build`/`build:static`/`prepack`/`start` no longer rely on a POSIX `VAR=value` prefix. No runtime or published-output change.
- Updated dependencies [3c3ee66]
- Updated dependencies [3c3ee66]
  - @uptimizr/db@1.0.2
  - @uptimizr/schema@1.0.1

## 1.0.1

### Patch Changes

- Updated dependencies [cd44b11]
  - @uptimizr/db@1.0.1

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

### Minor Changes

- fceff6c: New package: the optional single-tenant **PostgreSQL store** (`COLLECTOR_STORE=postgres`, #84). A
  pooled `pg` client, forward-only idempotent migrations (advisory-locked for concurrent collector
  boots), batched event inserts, replay-complete session reads, project / API-key metadata and the
  scene registry — the full `CollectorStore` surface, rendering the shared dialect-agnostic
  aggregations via `postgresDialect` (ASOF joins emulated with `LATERAL`, daily rollups recomputed at
  query time). Parity with DuckDB is asserted directly on every aggregation by live suites that skip
  when no Postgres is reachable.

### Patch Changes

- Updated dependencies [29c167d]
- Updated dependencies [fceff6c]
- Updated dependencies [9dd78e8]
  - @uptimizr/db@1.0.0
  - @uptimizr/schema@1.0.0
