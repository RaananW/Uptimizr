---
"@uptimizr/collector-server": minor
---

`uptimizr init`, `uptimizr new-project` and `uptimizr migrate` now honour `COLLECTOR_STORE`
(`duckdb` | `postgres` | `mssql` | `clickhouse`), bootstrapping the selected store through the same
connection variables `serve` reads (`DUCKDB_PATH`, `POSTGRES_URL`, `MSSQL_URL`, `CLICKHOUSE_*`, …)
instead of always targeting DuckDB. The project and key minted by `init` are therefore the ones the
running collector resolves, and `init` records the selected store (plus any connection variables
that were set) in the `.env` it writes. `COLLECTOR_STORE=memory` and unknown values now fail with an
actionable error. Pairs with `create-uptimizr --store <s>` (#267).
