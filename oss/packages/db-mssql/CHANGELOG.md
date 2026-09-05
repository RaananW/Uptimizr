# @uptimizr/db-mssql

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

### Minor Changes

- 29c167d: New package: the optional single-tenant **Microsoft SQL Server store** (`COLLECTOR_STORE=mssql`,
  #85). A pooled `mssql` (tedious) client with plain-JS value normalization, forward-only idempotent
  migrations serialized behind `sp_getapplock` (so several collector instances can boot against one
  database), batched event inserts with vectors stored as JSON arrays, replay-complete session
  reads, project / API-key metadata and the scene registry — the full `CollectorStore` surface,
  rendering the shared dialect-agnostic aggregations via `mssqlDialect` (ASOF joins emulated with
  `CROSS`/`OUTER APPLY`, exact percentiles through a migration-created T-SQL helper, daily rollups
  recomputed at query time). Parity with DuckDB is asserted directly on every aggregation by live
  suites that skip when no SQL Server is reachable. Requires SQL Server 2022 / Azure SQL.

### Patch Changes

- Updated dependencies [29c167d]
- Updated dependencies [fceff6c]
- Updated dependencies [9dd78e8]
  - @uptimizr/db@1.0.0
  - @uptimizr/schema@1.0.0
