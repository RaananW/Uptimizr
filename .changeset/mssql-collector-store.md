---
"@uptimizr/collector-server": patch
---

`COLLECTOR_STORE=mssql` selects the new single-tenant Microsoft SQL Server store
(`@uptimizr/db-mssql`, #85) — connection from `MSSQL_URL` or the discrete `MSSQL_SERVER` /
`MSSQL_PORT` / `MSSQL_DATABASE` / `MSSQL_USER` / `MSSQL_PASSWORD` settings; the database is created
on first boot when the login may. No change to routes, schema contracts, or the dashboard.
