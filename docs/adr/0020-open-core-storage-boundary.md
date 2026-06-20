# ADR 0020: Open-core storage boundary — DuckDB for OSS, ClickHouse + Postgres as the scale tier

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
for two stores is a future need for concurrent, multi-tenant, transactional metadata (orgs, users,
memberships, billing) that only a large-scale deployment requires.

The result is an adoption barrier exactly where we least want one: a hobby or small open-source 3D
project must stand up and operate **two** databases just to capture clicks on a scene.

[ADR 0019](./0019-simplified-single-store-backend.md) proposed DuckDB as an _additional_ simplified
backend. This ADR goes further and turns it into an **open-core boundary**:

- The **OSS collector** ships a single embedded store (DuckDB) and a fully-functional analytics
  surface — heatmaps included. No second database, no service to operate.
- The **two-store design (ClickHouse + Postgres) becomes an optional, separately-licensed scale
  tier**, justified by what it uniquely enables: scale, concurrency, multi-tenancy, and billing.

Two existing seams make this a contained change rather than a rewrite:

1. The OSS **dashboard never touches a database** — it talks to the collector purely over HTTP via
   `CollectorApi` (`oss/apps/dashboard/src/lib/api.ts`). It cannot tell which engine is behind the
   API, so the backend swap is invisible to it.
2. Storage already lives behind the **`CollectorStore`** interface, selected at boot in
   `oss/apps/collector-server/src/server.ts`. "Which database" is an internal implementation detail.

DuckDB is a persisted, single-file, in-process database (ACID, WAL crash recovery; backup = copy the
file) with one hard constraint: **a single read-write process at a time**. That constraint is a
perfect fit for a single-instance self-host and is precisely the line that justifies keeping
scale/multi-writer in a separately-licensed scale tier.

## Decision

Adopt an **open-core storage boundary**:

1. **OSS = a single DuckDB store, today.** DuckDB holds _both_ events and the small metadata tables
   (`projects`, `api_keys`, scene registry) in one file. It implements the full `CollectorStore`
   contract — including the heavy aggregates (heatmaps, perf, click↔gaze rays). It is the OSS
   **default** store; the in-memory store remains for tests/E2E only.
2. **The closed line is the multi-tenant _scale layer_, not the ClickHouse engine.** What lives in
   the separately-licensed scale tier is: multi-tenant org scoping, tenant isolation, the
   materialized-view rollups, cross-tenant operations, and billing. A _single-tenant_ ClickHouse
   analytics adapter is **not** inherently proprietary and may be offered as an OSS-selectable
   store later (see "Future: an OSS ClickHouse store" below).
3. **For now, the OSS repo ships only the DuckDB store.** The Apache-2.0 OSS `@uptimizr/db` keeps
   the DuckDB store + the metadata tables it needs; the ClickHouse scale adapter lives in a
   separately-licensed package outside this repo.
4. **Storage stays engine-agnostic behind two seams.** (a) `CollectorStore` is the data-access
   contract; (b) aggregations are expressed against a **dialect-agnostic query layer** so each
   aggregation is defined once conceptually and emitted per SQL dialect. Adding or relocating an
   engine (DuckDB ↔ ClickHouse, OSS or hosted) is a store-selection + dialect change — never a
   change to routes, schema, or the contract.

**Non-negotiable product stance:** the OSS variant must be **fully functional at small scale**. We do
not stub or cripple features (e.g. heatmaps) to drive paid upgrades. The differentiator is
**scale, concurrency, and multi-tenancy — not features, and not the choice of engine.**

## What moves where

| Component (today: all Apache-2.0 in `oss/packages/db`)                                | After this ADR                                                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ClickHouse client (`createClickHouseClient`)                                          | → separately-licensed scale tier (relocatable to OSS later — not inherently proprietary) |
| ClickHouse query builders (the ~13 aggregations, single-tenant)                       | → separately-licensed scale tier (relocatable to OSS later)                       |
| Materialized-view rollups (`perf_daily`, `events_daily`), tenant isolation            | → separately-licensed scale tier (**proprietary — the actual scale layer**)       |
| Multi-tenant org scoping, billing                                                     | → separately-licensed scale tier (**proprietary**)                                |
| Postgres tenancy/org/user/session clients                                             | → separately-licensed scale tier (proprietary)                                    |
| Postgres metadata clients (`projects`, `api_keys`)                                    | re-homed onto the DuckDB store for OSS                                            |
| **New:** DuckDB client + the aggregations in DuckDB dialect                           | `oss/packages/db` (Apache-2.0)                                                    |
| **New:** dialect-agnostic query layer (one definition per aggregation)                | `oss/packages/db` (Apache-2.0)                                                    |
| `CollectorStore` interface, routes, enrichment, schema                                | unchanged                                                                         |

## Future: an OSS ClickHouse store

The boundary above is deliberately drawn around **multi-tenancy and scale operations**, not around
ClickHouse itself. This keeps the door open to a future **OSS, single-tenant ClickHouse store**
(`COLLECTOR_STORE=clickhouse`) for self-hosters who outgrow DuckDB's single-writer model but do not
need the hosted SaaS. Because aggregations are authored once against the dialect-agnostic query
layer, that future store is a _re-home + dialect emitter_, not a rewrite: the single-tenant
ClickHouse adapter can be added to `oss/packages/db` under Apache-2.0,
leaving only the rollups, tenant isolation, org scoping, and billing on the proprietary side. The
architecture must therefore treat the engine as **pluggable** and never let multi-tenant concerns
leak into the single-tenant query definitions.

## Consequences

### Positive

- **Lowest possible adoption floor for OSS:** one process, one file, full analytics. A self-hoster
  runs the collector and nothing else.
- **Clean open-core line:** OSS is genuinely useful and complete; the commercial tier charges for
  _operating at scale_, not for basic functionality — the open-core model least likely to cause
  community backlash.
- **Clean repo extraction:** the OSS collector has zero ClickHouse references, so it lives happily
  on its own.
- **Dashboard and routes are unaffected** — the change is invisible above the `CollectorStore` seam.
- DuckDB matches ClickHouse on the query surface (`ASOF JOIN`, `quantile`, arrays), so the OSS
  analytics stay behaviorally close to the scale engine.

### Negative / trade-offs

- **Released code cannot be un-published.** The current ClickHouse queries already shipped under
  Apache-2.0 in git history; this ADR closes _future_ scale-engine work, not the already-released
  version. The honest framing is "new scale + multi-tenancy work is proprietary," not "ClickHouse
  analytics are secret."
- **The IP being closed is thinner than it looks.** Because the OSS DuckDB store reimplements all the
  aggregations in the open, the analytics _logic_ stays public; only the ClickHouse _dialect_ plus
  the multi-tenant rollups/isolation become proprietary. The defensible value is "scale +
  multi-tenancy," not hidden analytics.
- **Two analytics implementations to maintain**, now straddling a license boundary. Parity tests
  (DuckDB vs. ClickHouse "golden output") live on the scale-tier side, which weakens the open
  repo's ability to self-verify dialect agreement. Every new aggregation/event type costs two
  implementations.
- **Single-writer in OSS.** Horizontal scale / multiple writer processes are explicitly out of scope
  for the OSS store; that is the scale tier's job.
- **The scale tier owns more code.** It no longer reuses the OSS collector's storage wholesale; it
  maintains its own scale store. This is the natural cost of the open-core line and is where that
  code belongs.
- DuckDB adds a native binary dependency (`@duckdb/node-api` or equivalent) to the OSS collector.

## Alternatives considered

- **Keep two stores everywhere (status quo, ADR 0002).** Rejected for OSS: imposes a two-database
  operational burden on the exact low-budget audience the collector targets, for a metadata workload
  that does not need it.
- **DuckDB as an _additive_ option, ClickHouse still the OSS default (ADR 0019).** Superseded:
  leaves the two-database floor in place for OSS and keeps the scale engine in the Apache-2.0 tree,
  blurring the open-core line. Making DuckDB the OSS default-and-only is simpler to reason about and
  to license.
- **Postgres-only for OSS.** Removes a service but is a row store pushed into an OLAP role (weakest
  on aggregations, highest rewrite cost for `ASOF`, weaker raw-payload compression) and still
  requires running a server. DuckDB gives a better analytics experience with no service at all.
- **Crippled OSS (stub heavy aggregates, upsell hosted for heatmaps).** Rejected on principle: the
  credibility of the whole split depends on OSS being fully functional at small scale.
