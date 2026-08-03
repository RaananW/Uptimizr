---
"@uptimizr/collector-server": patch
"@uptimizr/dashboard": patch
"@uptimizr/db": patch
---

Update runtime dependencies to their latest releases: Fastify and its rate-limit
plugin (collector-server), Babylon.js core and loaders (dashboard), and the DuckDB
Node API (db). Development-only tooling across the workspace was refreshed to latest
as well; TypeScript is intentionally held back pending the 7.x migration.
