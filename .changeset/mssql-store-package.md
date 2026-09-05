---
"@uptimizr/db-mssql": minor
---

New package: the optional single-tenant **Microsoft SQL Server store** (`COLLECTOR_STORE=mssql`,
#85). A pooled `mssql` (tedious) client with plain-JS value normalization, forward-only idempotent
migrations serialized behind `sp_getapplock` (so several collector instances can boot against one
database), batched event inserts with vectors stored as JSON arrays, replay-complete session
reads, project / API-key metadata and the scene registry — the full `CollectorStore` surface,
rendering the shared dialect-agnostic aggregations via `mssqlDialect` (ASOF joins emulated with
`CROSS`/`OUTER APPLY`, exact percentiles through a migration-created T-SQL helper, daily rollups
recomputed at query time). Parity with DuckDB is asserted directly on every aggregation by live
suites that skip when no SQL Server is reachable. Requires SQL Server 2022 / Azure SQL.
