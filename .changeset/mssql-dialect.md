---
"@uptimizr/db": patch
---

Add `mssqlDialect` for the SQL Server store (#85) plus `MssqlSettings` via `readDbSettings().mssql`
(`MSSQL_URL`, or `MSSQL_SERVER` / `MSSQL_PORT` / `MSSQL_DATABASE` / `MSSQL_USER` / `MSSQL_PASSWORD`,
`MSSQL_ENCRYPT`, `MSSQL_TRUST_SERVER_CERTIFICATE`, `MSSQL_POOL_MAX`), and `toTsql` — the
execution-time adaptation of the shared SQL for the constructs T-SQL cannot parse (inline vector
indexing over JSON arrays, `LIMIT`, `GROUP BY <alias>`, `atan2`). The three boolean-valued flag
columns in the shared aggregations became portable 0/1 flags; DuckDB, ClickHouse and Postgres
output is unchanged (parity suites pass as before). No `Dialect` interface change.
