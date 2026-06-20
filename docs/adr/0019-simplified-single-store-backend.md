# ADR 0019: Simplified single-store backend for low-requirement self-hosting

- **Status:** Superseded by [ADR 0020](./0020-open-core-storage-boundary.md)
- **Date:** 2026-06-17
- **Deciders:** Project owner, engineering
- **Relates to:** [ADR 0002](./0002-database.md) (does not supersede — adds an option)

> **Superseded:** This ADR proposed DuckDB as an _additive, optional_ simplified backend alongside
> the ClickHouse/Postgres default. [ADR 0020](./0020-open-core-storage-boundary.md) supersedes it:
> DuckDB becomes the **default and only** store, and the two-store design becomes an optional
> scale tier. The analysis below — the DuckDB-vs-Postgres-only
> decision matrix in particular — remains the rationale for choosing DuckDB and is retained for
> reference.

## Context

[ADR 0002](./0002-database.md) chose a two-store design — ClickHouse for events, Postgres for
metadata — and it remains the right choice for scale. But it raises the
floor for **self-hosters**: a hobby or small open-source 3D project that wants basic analytics must
stand up and operate ClickHouse _and_ Postgres just to try the collector. That is a real adoption
barrier for the exact audience the OSS collector targets.

The codebase already anticipates a swappable backend:

- `CollectorStore` (`oss/apps/collector-server/src/store.ts`) is the single data-access contract the
  routes depend on; the framework and DB are meant to stay replaceable (ADR 0005).
- The server selects an implementation at boot via `COLLECTOR_STORE`
  (`oss/apps/collector-server/src/server.ts`): the ClickHouse/Postgres `createDbStore` by default,
  or a dependency-free `createMemoryStore` for local/E2E.

So the **seam exists**. What is _not_ portable is the analytics SQL: the ~13 `*Query` builders in
`@uptimizr/db` (`oss/packages/db/src/clickhouse/queries.ts`) use ClickHouse-specific features —
`ASOF JOIN` (click↔gaze correlation), `quantile()`, `Array(Float32)` indexing, `L2Norm`,
day-partitioning, and `AggregatingMergeTree` materialized-view rollups. The in-memory store sidesteps
this by stubbing the heavy aggregates (heatmaps/perf/top-meshes return `[]`), which is fine for tests
but not a real product experience.

This ADR decides **which database** backs a simplified, single-dependency `CollectorStore` for
low-requirement deployments — and explicitly weighs whether DuckDB should be that backend.

## Decision

Add a **DuckDB-backed `CollectorStore`** as the simplified single-store option for self-hosting,
selectable via `COLLECTOR_STORE=duckdb` (embedded, single file). Keep ClickHouse + Postgres as the
option for large, multi-writer deployments at scale.

DuckDB is chosen over a Postgres-only backend because it is the closest _functional_ match to the
existing ClickHouse SQL — it natively supports `ASOF JOIN`, `quantile`, arrays, and columnar
aggregation — which minimizes query rewrites, avoids a scaling cliff on the highest-volume event
types, and preserves the product's most distinctive analytics (click↔gaze rays) with the least risk
of behavioral divergence.

This is **additive** to ADR 0002, not a replacement. ClickHouse is _not_ removed: DuckDB's
embedded, single-writer model is appropriate for a single self-hosted collector instance but **not**
for a concurrent, multi-writer deployment at scale.

## Decision matrix

Legend: ✅ strong · 🟡 workable with effort · ❌ poor fit

| Criterion                                   | ClickHouse + Postgres (current, ADR 0002) | Postgres-only                             | **DuckDB (proposed)**                          |
| ------------------------------------------- | ----------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| Operational footprint for self-hoster       | ❌ two services to run/migrate/back up    | ✅ one service (already a dependency)     | ✅ embedded, single file, no service           |
| Concurrent / multi-writer                   | ✅ built for it                           | ✅ built for it                           | ❌ single-writer embedded                      |
| Columnar analytical performance             | ✅ purpose-built                          | ❌ row store, full-row scans              | ✅ columnar (vectorized)                       |
| `ASOF JOIN` (click↔gaze, flow)              | ✅ native                                 | ❌ emulate via `LATERAL` (slowest path)   | ✅ native                                      |
| Percentiles (`perfSummary` p50)             | ✅ `quantile()`                           | 🟡 `percentile_cont`                      | ✅ `quantile()`                                |
| Float vector arrays (`direction[1]`…)       | ✅ `Array(Float32)`                       | 🟡 PG arrays (1-indexed)                  | ✅ `LIST`/array indexing                       |
| Time-partition pruning                      | ✅ `PARTITION BY toYYYYMMDD`              | 🟡 declarative partitioning + maintenance | 🟡 partition by file/`ts` filter; no MergeTree |
| Materialized-view rollups (`perf_daily`)    | ✅ `AggregatingMergeTree`                 | ❌ build rollup tables + refresh job      | 🟡 recompute at query time (fast columnar)     |
| Raw-retention storage cost (`payload` JSON) | ✅ strong columnar compression            | ❌ weak TOAST compression                 | ✅ good columnar compression                   |
| Ingestion under high event rate             | ✅ `async_insert`, light                  | 🟡 MVCC/index/vacuum pressure             | 🟡 batch appends; single-writer serializes     |
| Query-rewrite effort from current SQL       | — (baseline)                              | ❌ high (ASOF + rollups + percentiles)    | 🟡 low–moderate (dialect, not concepts)        |
| Familiarity / ecosystem                     | ✅ widely known                           | ✅ ubiquitous                             | 🟡 newer, growing                              |
| Fit for the scale tier                      | ✅ the target                             | 🟡 possible at small scale                | ❌ not suitable (single-writer)                |

### Reading the matrix

- **Postgres-only** wins only on _familiarity_ and _"already a dependency."_ On the axes that
  actually matter for this workload — columnar aggregation, `ASOF JOIN`, rollups, raw-retention
  storage — it is the weakest, and it carries the **highest rewrite effort** (the two ASOF queries
  become the slowest path in the system, plus hand-built rollup tables and refresh jobs).
- **DuckDB** matches ClickHouse feature-for-feature on the query surface, so the simplified backend
  stays _behaviorally_ close to production with the least new SQL — and it removes the service
  entirely (embedded file) rather than merely consolidating to one server.
- The one place DuckDB loses is **concurrency**, which is exactly the dimension a low-requirement,
  single-instance self-host does not need — and the dimension the scale tier keeps ClickHouse
  for.

## Is DuckDB the better option _altogether_?

For the **OSS / self-host default**: arguably yes — it is the lowest-friction way to get the _full_
analytics experience (heatmaps included) on one dependency, and it is the closest match to the
existing SQL.

For **replacing ClickHouse outright** (including the scale tier): **no.** DuckDB is embedded and
single-writer; the scale tier is concurrent and multi-writer. Betting a multi-writer
deployment at scale on an embedded
analytics engine would trade a proven scaling story for an operational liability. The right framing
is **tiered**: DuckDB for "one scene, one box, low budget"; ClickHouse for "scale."

## Consequences

### Positive

- Self-hosters get the **full** analytics surface (heatmaps, perf, click↔gaze) with a single,
  zero-service file database — a dramatically lower adoption floor than ADR 0002.
- The new backend stays behaviorally close to production because the SQL dialect, not the query
  _logic_, is what changes — lower risk of divergent results.
- No change to routes, enrichment, schema, or the `CollectorStore` contract; this is one new package
  implementation behind the existing seam.
- ClickHouse remains the documented path for scale — no regression.

### Negative / trade-offs

- **Two query implementations to maintain.** Every new aggregation/event type (the `add-event-type`
  flow) now needs both a ClickHouse and a DuckDB query, plus parity tests to prevent drift.
- **Single-writer.** Suitable for one collector instance; horizontal scale or multiple writer
  processes are out of scope for this backend (use ClickHouse).
- **No MergeTree-style background rollups.** Daily trend endpoints (`perfDaily`/`eventsDaily`)
  recompute at query time; acceptable at small scale but slower as history grows.
- **Newer ecosystem.** Fewer battle-tested ops/backup patterns than Postgres or ClickHouse; mitigated
  by the database being a single file (copy = backup).
- A new runtime dependency (`@duckdb/node-api` or equivalent) and its native binary in the collector.

## Alternatives considered

- **Postgres-only.** Removes a service and reuses an existing dependency, and is genuinely _fine_ at
  the thousands–low-millions-of-events scale of the target audience. Rejected as the _primary_
  simplified backend because it is a row store pushed into an OLAP role: weakest on the aggregation
  workload, highest query-rewrite cost (ASOF emulation via `LATERAL`, hand-built rollups, weaker raw
  compression), and it still requires running a server. May still be worth offering later for shops
  that _only_ want Postgres, but it is not the recommended low-requirement default.
- **SQLite.** Smallest possible footprint, but the weakest SQL for this workload — no native
  percentile, math functions behind a compile flag, JSON extraction for vectors, no ASOF. Highest
  rewrite cost for the least analytical capability.
- **Keep only the in-memory store for "lite."** Already exists, but stubs out every heavy aggregate
  (no heatmaps) and is non-durable — not a real product experience.
- **Replace ClickHouse with DuckDB everywhere.** Rejected: DuckDB's single-writer embedded model is
  unsuitable for a concurrent, multi-writer deployment at scale.
