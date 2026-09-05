---
"@uptimizr/db-postgres": minor
---

New package: the optional single-tenant **PostgreSQL store** (`COLLECTOR_STORE=postgres`, #84). A
pooled `pg` client, forward-only idempotent migrations (advisory-locked for concurrent collector
boots), batched event inserts, replay-complete session reads, project / API-key metadata and the
scene registry — the full `CollectorStore` surface, rendering the shared dialect-agnostic
aggregations via `postgresDialect` (ASOF joins emulated with `LATERAL`, daily rollups recomputed at
query time). Parity with DuckDB is asserted directly on every aggregation by live suites that skip
when no Postgres is reachable.
