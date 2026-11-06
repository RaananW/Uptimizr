---
"@uptimizr/collector-server": minor
"@uptimizr/db": minor
"@uptimizr/db-clickhouse": minor
"@uptimizr/db-mssql": minor
"@uptimizr/db-postgres": minor
"@uptimizr/agent-core": patch
"@uptimizr/mcp": patch
---

Add `EVENT_RETENTION_DAYS`, an optional window after which the collector deletes stored events, including `node_transform` samples. It defaults to `0` (keep forever), so upgrading deletes nothing. Aggregates are computed from those rows at query time, so a purge also removes those days from every aggregate, permanently, and a DuckDB file does not shrink until it is compacted. Store contracts gain `pruneEvents(cutoffMs)`. The assistant's project context now says raw session access is off rather than that raw retention is off, and the `@uptimizr/mcp` description no longer claims the server is read-only for every key. See ADR 0052.
