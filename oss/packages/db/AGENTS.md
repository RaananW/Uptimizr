# AGENTS.md — @uptimizr/db

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The OSS storage contracts plus the single-file **DuckDB** store (ADR 0020):

- **DuckDB** — one persisted `.duckdb` file holding both events and metadata. A wide `events`
  table (hot fields promoted to columns; the full event preserved as JSON in `payload` so reads
  stay replay-complete) plus `projects` / `api_keys` (stored only as SHA-256 hashes).
- **Engine-neutral contracts** — the dialect-agnostic query layer (`buildX` + `Dialect`), the
  neutral event-row mapper (`toEventRow`, `formatUtcTimestamp`), and the metadata types
  (`Project`, `ApiKeyRecord`, `SceneRepresentation*`). An optional, separately-licensed
  scale store composes these to drive its single-tenant ClickHouse + Postgres engines.

This package carries **no ClickHouse/Postgres dependency**. The optional scale engines live in a
separately-licensed scale store. Server/Node only — no DOM imports. Aggregations are
**query-time** in v1 (no materialized views).

## Install

```bash
pnpm add @uptimizr/db
```

## Canonical usage

```ts
import {
  createDuckdbClient,
  migrateDuckdb,
  duckdbInsertEvents,
  duckdbGetSessionEvents,
  duckdbResolveApiKey,
  buildPointerHeatmap,
  duckdbDialect,
  runDuckdbQuery,
  type HeatmapBinRow,
} from "@uptimizr/db";

const db = await createDuckdbClient("./data/uptimizr.duckdb");
await migrateDuckdb(db);

await duckdbInsertEvents(db, events); // events validated upstream at the collector boundary
const heat = await runDuckdbQuery<HeatmapBinRow>(
  db,
  buildPointerHeatmap("project-id", { bins: 50 }, duckdbDialect),
);
const timeline = await duckdbGetSessionEvents(db, "project-id", "session-id");
const projectId = await duckdbResolveApiKey(db, "utk_…");
```

Connection settings come from the environment (`readDbSettings()`); when `DUCKDB_PATH` is unset
the store defaults to `<repo-root>/data/uptimizr.duckdb`, resolved against the monorepo root so
every tool (collector + CLIs) shares one canonical file regardless of cwd.

## Rules for agents

- **Migrations are forward-only and additive.** Append to `DUCKDB_MIGRATIONS`; never edit a
  shipped migration (ADR 0007). The ClickHouse/Postgres scale migrations live alongside the
  scale store.
- A new aggregation = a pure `buildX(projectId, opts, dialect)` builder returning a `QuerySpec`
  (`{ query, query_params }`), run with `runDuckdbQuery`. Keep builders pure, dialect-agnostic,
  and unit-tested without a live database; add a `PARITY_CASES` entry so both engines stay equal.
- Validate events upstream at the collector boundary; this layer assumes valid input.
- API keys are only ever stored as SHA-256 hashes — never persist raw keys.
- **Single-writer store.** DuckDB allows only one read-write process per file; assume a single
  collector per `.duckdb` file. Back up = copy the file. Multi-writer / horizontal scale is the
  optional ClickHouse scale tier, not this package.

## Cross-engine parity (ADR 0020)

The dialect-agnostic aggregations (`buildX(projectId, opts, dialect)`) are rendered per engine
(`duckdbDialect` for OSS, `clickhouseDialect` for the scale tier). A shared parity harness
proves the engines produce equal analytics:

- `PARITY_EVENTS` — one deterministic fixture event set exercising every aggregation (2D/3D
  heatmaps, the camera-direction gaze heatmap, the ASOF click↔gaze ray and flow joins, quantile
  perf, the daily rollups, and the scene/session dimensions).
- `PARITY_CASES` — each aggregation paired with its engine-independent **golden** output (authored
  as truth, hand-verified from the fixtures).
- `diffParity(actual, golden, { sortKeys, ignoreColumns })` — compares under the tolerance rules
  below and returns a list of differences (empty = parity).

OSS ships the **DuckDB-vs-golden** suite (`src/__tests__/duckdbParity.test.ts`, CI-runnable, no
service). The scale tier reuses the same exported `PARITY_CASES`/golden to run
**DuckDB-vs-ClickHouse**; two engines that both match the golden are in parity by transitivity.

**Tolerance rules** (see `src/parity/compare.ts`):

1. **Order-insensitive** — rows are compared as a multiset, sorted by each case's `sortKeys`
   (SQL guarantees no order beyond `ORDER BY`, and `ORDER BY count` ties are unstable).
2. **Float tolerance** — continuous numeric columns (averages, quantiles, ASOF ray origins/hits)
   match within `PARITY_ABS_TOLERANCE` (1e-6 absolute) or `PARITY_REL_TOLERANCE` (1e-9 relative).
3. **Bin indices are integer-exact** — `floor(...)` heatmap bins are integers; fixtures avoid
   exact bin boundaries where a sub-ulp difference could flip the floor across engines.
4. **Temporal projections excluded** — wall-clock `TIMESTAMP` columns (`started_at`, `ended_at`,
   `last_seen`) render differently per engine and are listed in `ignoreColumns`; date-granular
   `day` strings (`YYYY-MM-DD`) render identically and are compared.

When adding an aggregation or event type, extend `PARITY_EVENTS`/`PARITY_CASES` with golden so both
engines stay covered.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
