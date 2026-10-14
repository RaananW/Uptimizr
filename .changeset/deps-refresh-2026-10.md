---
"@uptimizr/schema": patch
"@uptimizr/metrics": patch
"@uptimizr/db": patch
"@uptimizr/db-postgres": patch
"@uptimizr/db-mssql": patch
"@uptimizr/db-clickhouse": patch
"@uptimizr/collector-server": patch
"@uptimizr/agent-core": patch
"@uptimizr/mcp": patch
"@uptimizr/replay": patch
"@uptimizr/dashboard": patch
---

Refresh runtime dependencies across the workspace: Zod 4.6.7 (every package that validates at a boundary), Fastify 5.12.7 with `@fastify/cors` 11.3.1, `@fastify/helmet` 13.2.0, `@fastify/rate-limit` 11.2.1 and `@fastify/static` 10.1.6 (collector-server), `@modelcontextprotocol/sdk` 1.32.1 (collector-server, mcp), `@duckdb/node-api` 1.5.6-r.1 (db), `pg` 8.23.1 (db-postgres), `mssql` 12.7.6 (db-mssql), `@clickhouse/client` 1.24.1 (db-clickhouse), and Next.js 16.4.0, React 19.3.0, Babylon.js 9.30.0 and WebLLM 0.2.86 (dashboard). No API or behaviour changes.
