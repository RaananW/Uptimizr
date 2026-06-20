# ADR 0020: Single-store OSS backend — DuckDB default, ClickHouse + Postgres as an optional scale tier

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Project owner, engineering
- **Supersedes:** [ADR 0019](./0019-simplified-single-store-backend.md) (DuckDB becomes the OSS
  _default and only_ store, not an additive option)
- **Amends:** [ADR 0002](./0002-database.md) (two-store design is retained, but scoped to the scale tier)

## Context

[ADR 0002](./0002-database.md) made the two-store design (ClickHouse for events, Postgres for
metadata) the floor for _every_ deployment, including the open-source collector. In practice the
Postgres metadata workload is tiny — a handful of small relational tables (`projects`,
`api_keys` as SHA-256 hashes, the scene registry) served by point lookups — and the genuine reason
for two stores is a future need for concurrent, high-volume ingestion and transactional metadata
that only a large-scale deployment requires.

The result is an adoption barrier exactly where we least want one: a hobby or small open-source 3D
project must stand up and operate **two** databases just to capture clicks on a scene.

[ADR 0019](./0019-simplified-single-store-backend.md) proposed DuckDB as an _additional_ simplified
backend. This ADR goes further and turns it into a **storage-tiering boundary**:

- The **collector** ships a single embedded store (DuckDB) and a fully-functional analytics
  surface — heatmaps included. No second database, no service to operate.
- The **two-store design (ClickHouse + Postgres) becomes an optional scale tier**, justified by
  what it uniquely enables: scale, concurrency, and high-volume ingestion.

Two existing seams make this a contained change rather than a rewrite:

1. The OSS **dashboard never touches a database** — it talks to the collector purely over HTTP via
   `CollectorApi` (`oss/apps/dashboard/src/lib/api.ts`). It cannot tell which engine is behind the
   API, so the backend swap is invisible to it.
2. Storage already lives behind the **`CollectorStore`** interface, selected at boot in
   `oss/apps/collector-server/src/server.ts`. "Which database" is an internal implementation detail.

DuckDB is a persisted, single-file, in-process database (ACID, WAL crash recovery; backup = copy the
file) with one hard constraint: **a single read-write process at a time**. That constraint is a
perfect fit for a single-instance self-host and is precisely the line that justifies keeping
scale/multi-writer in a separate, optional scale tier.

## Decision

Adopt a **single-store backend with an optional scale tier**:

1. **OSS = a single DuckDB store, today.** DuckDB holds _both_ events and the small metadata tables
   (`projects`, `api_keys`, scene registry) in one file. It implements the full `CollectorStore`
   contract — including the heavy aggregates (heatmaps, perf, click↔gaze rays). It is the
   **default** store; the in-memory store remains for tests/E2E only.
2. **The line is the _scale layer_, not the ClickHouse engine.** What lives in
   the optional scale tier is: multi-writer concurrency, the materialized-view rollups, and
   high-volume operational tuning. A _single-instance_ ClickHouse analytics adapter
   may be offered as a selectable store later (see "Future: a ClickHouse store" below).
3. **For now, the repo ships only the DuckDB store.** `@uptimizr/db` keeps
   the DuckDB store + the metadata tables it needs; the optional ClickHouse scale adapter lives in a
   separate package outside this repo.
4. **Storage stays engine-agnostic behind two seams.** (a) `CollectorStore` is the data-access
   contract; (b) aggregations are expressed against a **dialect-agnostic query layer** so each
   aggregation is defined once conceptually and emitted per SQL dialect. Adding or relocating an
   engine (DuckDB ↔ ClickHouse) is a store-selection + dialect change — never a
   change to routes, schema, or the contract.

**Non-negotiable product stance:** the collector must be **fully functional at small scale**. We do
not stub or cripple features (e.g. heatmaps). The scale tier differs only in
**scale and concurrency — not features, and not the choice of engine.**

## What moves where

| Component (today: all Apache-2.0 in `oss/packages/db`)                                | After this ADR                                                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ClickHouse client (`createClickHouseClient`)                                          | → optional scale tier (relocatable into OSS later)                                |
| ClickHouse query builders (the ~13 aggregations, single-tenant)                       | → optional scale tier (relocatable into OSS later)                                |
| Materialized-view rollups (`perf_daily`, `events_daily`)                              | → optional scale tier (**the actual scale layer**)                                |
| Postgres metadata clients (`projects`, `api_keys`)                                    | re-homed onto the DuckDB store                                                    |
| **New:** DuckDB client + the aggregations in DuckDB dialect                           | `oss/packages/db` (Apache-2.0)                                                    |
| **New:** dialect-agnostic query layer (one definition per aggregation)                | `oss/packages/db` (Apache-2.0)                                                    |
| `CollectorStore` interface, routes, enrichment, schema                                | unchanged                                                                         |

## Future: a ClickHouse store

The boundary above is deliberately drawn around **scale operations**, not around
ClickHouse itself. This keeps the door open to a future **single-tenant ClickHouse store**
(`COLLECTOR_STORE=clickhouse`) for self-hosters who outgrow DuckDB's single-writer model. Because
aggregations are authored once against the dialect-agnostic query
layer, that future store is a _re-home + dialect emitter_, not a rewrite: the single-tenant
ClickHouse adapter can be added to `oss/packages/db` under Apache-2.0,
leaving only the multi-writer rollups and scale tuning in the optional scale tier. The
architecture must therefore treat the engine as **pluggable** and never let scale-tier concerns
leak into the single-instance query definitions.

## Consequences

### Positive

- **Lowest possible adoption floor:** one process, one file, full analytics. A self-hoster
  runs the collector and nothing else.
- **Clean tiering line:** the collector is genuinely useful and complete on its own; the optional
  scale tier only adds capacity for operating at scale, not basic functionality.
- **Clean repo extraction:** the OSS collector has zero ClickHouse references, so it lives happily
  on its own.
- **Dashboard and routes are unaffected** — the change is invisible above the `CollectorStore` seam.
- DuckDB matches ClickHouse on the query surface (`ASOF JOIN`, `quantile`, arrays), so the
  analytics stay behaviorally close to the scale engine.

### Negative / trade-offs

- **The scale tier is maintained separately.** The current ClickHouse queries already shipped under
  Apache-2.0 in git history and stay open; future multi-writer scale work is maintained in the
  separate scale-tier package, not in this repo.
- **Two analytics implementations to maintain**, split across the OSS repo and the scale-tier
  package. Parity tests (DuckDB vs. ClickHouse "golden output") live on the scale-tier side. Every
  new aggregation/event type costs two implementations.
- **Single-writer in OSS.** Horizontal scale / multiple writer processes are explicitly out of scope
  for the OSS store; that is the scale tier's job.
- **The scale tier owns more code.** It no longer reuses the OSS collector's storage wholesale; it
  maintains its own scale store. This is the natural cost of the tiering line and is where that
  code belongs.
- DuckDB adds a native binary dependency (`@duckdb/node-api` or equivalent) to the OSS collector.

## Alternatives considered

- **Keep two stores everywhere (status quo, ADR 0002).** Rejected for OSS: imposes a two-database
  operational burden on the exact low-budget audience the collector targets, for a metadata workload
  that does not need it.
- **DuckDB as an _additive_ option, ClickHouse still the OSS default (ADR 0019).** Superseded:
  leaves the two-database floor in place for OSS and keeps the scale engine in the Apache-2.0 tree,
  blurring the tiering line. Making DuckDB the default-and-only is simpler to reason about and
  to operate.
- **Postgres-only for OSS.** Removes a service but is a row store pushed into an OLAP role (weakest
  on aggregations, highest rewrite cost for `ASOF`, weaker raw-payload compression) and still
  requires running a server. DuckDB gives a better analytics experience with no service at all.
- **Crippled features (stub heavy aggregates like heatmaps).** Rejected on principle: the
  collector must be fully functional at small scale.
