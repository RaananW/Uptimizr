---
"@uptimizr/db": patch
---

`DuckdbClient.close()` now closes the underlying DuckDB instance, not just its connection. The instance kept the database file open, so reopening the same `.duckdb` path after a close failed on Windows (which holds an exclusive lock) and leaked a handle everywhere else.
