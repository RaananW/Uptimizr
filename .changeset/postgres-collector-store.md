---
"@uptimizr/collector-server": patch
---

`COLLECTOR_STORE=postgres` selects the new single-tenant Postgres store (`@uptimizr/db-postgres`,
#84) — connection from `POSTGRES_URL` (or `DATABASE_URL`), optional `POSTGRES_SCHEMA` /
`POSTGRES_POOL_MAX`. No change to routes, schema contracts, or the dashboard.
