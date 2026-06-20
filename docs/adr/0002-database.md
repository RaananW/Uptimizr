# ADR 0002: Database — ClickHouse for events, Postgres for metadata

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

3D analytics produces high-volume, append-heavy event streams (camera samples, pointer moves,
mesh interactions). The product needs fast aggregations for heatmaps, sessions, and perf
summaries, while also storing relational metadata (projects, API keys) and, optionally, raw
per-session streams for replay. A single general-purpose database struggles to serve both the
OLAP aggregation workload and the relational/transactional workload well.

## Decision

Use a **two-store** design:

- **ClickHouse** for the event store. Columnar, purpose-built for analytics, with excellent
  aggregation performance and cheap, scalable ingestion. Events table partitioned by date and
  ordered by `(project_id, event_type, ts)`. This is the same class of store used by PostHog
  and Plausible.
- **Postgres** for metadata: projects, API keys, and (in Phase 2) orgs/users/billing.
  Relational, transactional, and well understood.

Heatmap aggregation is computed at **query time** in v1; ClickHouse materialized views are
deferred to the optional scale tier.

## Consequences

### Positive

- Aggregations over millions of events stay fast and inexpensive.
- Clear separation of concerns: analytical vs. relational workloads.
- Proven pattern for analytics products; straightforward to self-host via Docker.

### Negative / trade-offs

- Two databases to operate, migrate, and back up.
- ClickHouse has eventual-consistency and async-insert nuances the ingestion layer must handle.
- Cross-store joins (e.g., enriching events with project metadata) happen in the application
  layer, not the database.

## Alternatives considered

- **TimescaleDB / Postgres only** — simpler ops, but weaker on high-cardinality OLAP
  aggregations at scale.
- **DuckDB** — great embedded/local-first analytics, but not a server database for a hosted,
  concurrent, multi-writer service.
- **Azure Cosmos DB** — strong global distribution and low-latency point reads, but pricier and
  less suited to heavy columnar aggregation workloads central to this product.
