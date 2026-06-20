# @uptimizr/db

The OSS storage contracts plus the single-file **DuckDB** store:

- **DuckDB (OSS default)** — one persisted `.duckdb` file holds **both events and metadata**, so
  the collector self-hosts in a single process with no external database service. A wide `events`
  table (hot fields like camera `position`/`direction`, pointer `screen`, `mesh`, `fps` promoted to
  columns; the full event preserved as JSON in `payload` so reads stay replay-complete) plus
  `projects` / `api_keys` (stored only as SHA-256 hashes).
- **Engine-neutral contracts** — the dialect-agnostic query layer (`buildX` + `Dialect`), the
  neutral event-row mapper (`toEventRow`, `formatUtcTimestamp`), and the metadata types
  (`Project`, `ApiKeyRecord`, `SceneRepresentation*`).

This package carries **no ClickHouse/Postgres dependency**. An optional, separately-licensed
scale store (single-tenant ClickHouse + Postgres + rollups) composes these contracts
behind the same interface. Server/Node only — no DOM imports. Aggregations are
**query-time** in v1; no materialized views.

> **Single-writer constraint.** DuckDB is an embedded, single-writer store: only one process may
> open the file read-write at a time. Run a single collector per file; for multi-writer /
> horizontal scale use the ClickHouse scale path. **Back up = copy the file.**

## Usage

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

// ingest (events are validated upstream at the collector boundary)
await duckdbInsertEvents(db, events);

// query-time aggregation: one spec, rendered for the DuckDB dialect
const heat = await runDuckdbQuery<HeatmapBinRow>(
  db,
  buildPointerHeatmap("project-id", { bins: 50 }, duckdbDialect),
);

// ordered replay/timeline read
const timeline = await duckdbGetSessionEvents(db, "project-id", "session-id");

// authenticate ingestion
const projectId = await duckdbResolveApiKey(db, "utk_…");
```

Connection settings come from the environment (see [`.env.example`](../../../.env.example));
`readDbSettings()` exposes them. When `DUCKDB_PATH` is unset the store defaults to
`<repo-root>/data/uptimizr.duckdb` — resolved against the monorepo root (the directory with
`pnpm-workspace.yaml`), not the process cwd, so the collector and the migrate/seed/new-project
CLIs all share one canonical file regardless of which package they run from.

## Extending

- **New columns / tables:** append a migration to `DUCKDB_MIGRATIONS`. Forward-only and additive —
  never edit a shipped migration. The ClickHouse/Postgres scale migrations live alongside the
  scale store.
- **New aggregation — define once, emit per dialect:** add a pure
  `buildX(projectId, opts, dialect)` builder in `src/query/aggregations.ts` that renders a
  `QuerySpec` (`{ query, query_params }`) using the `Dialect` fragments (never hard-code
  engine-specific SQL). Run it with `runDuckdbQuery(db, buildX(..., duckdbDialect))`; the scale
  path runs the _same_ builder with `clickhouseDialect`. Add a `PARITY_CASES` entry so both engines
  stay provably equal. Builders are pure and unit-tested without a live database.

## Develop

```bash
pnpm --filter @uptimizr/db build
pnpm --filter @uptimizr/db typecheck
pnpm --filter @uptimizr/db test
```

Integration against real ClickHouse/Postgres lives with the scale store; the unit
tests here cover the pure mapping, the dialect-agnostic SQL builders, and the DuckDB store against
an in-memory (`:memory:`) database.

## License

[Apache-2.0](./LICENSE) © Uptimizr.
