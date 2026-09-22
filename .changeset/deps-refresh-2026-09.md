---
"@uptimizr/schema": patch
"@uptimizr/metrics": patch
"@uptimizr/db": patch
"@uptimizr/db-mssql": patch
"@uptimizr/collector-server": patch
"@uptimizr/agent-core": patch
"@uptimizr/mcp": patch
"@uptimizr/replay": patch
"@uptimizr/dashboard": patch
---

Refresh runtime dependencies across the workspace: Zod 4.6.5 (every package that validates at a boundary), Fastify 5.12.5 and `@fastify/static` 10.1.4 (collector-server), `@duckdb/node-api` 1.5.5-r.5 (db), `mssql` 12.7.2 (db-mssql), and Next.js 16.3.5, Babylon.js 9.27.1 and WebLLM 0.2.85 (dashboard). No API or behaviour changes; `pnpm audit` stays clean.
