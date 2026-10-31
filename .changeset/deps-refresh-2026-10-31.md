---
"@uptimizr/collector-server": patch
"@uptimizr/mcp": patch
"@uptimizr/db-mssql": patch
"@uptimizr/dashboard": patch
"@uptimizr/heatmap": patch
---

Refresh runtime dependencies: `@fastify/static` 10.1.8 and `@modelcontextprotocol/sdk` 1.32.2 (collector-server, mcp), `mssql` 12.7.13 (db-mssql), and Next.js 16.4.3, React 19.3.1, Babylon.js 9.33.1 and WebLLM 0.2.87 (dashboard). The Babylon Lite heatmap driver now shows and hides its voxel mesh with `setMeshVisible()` instead of writing `mesh.visible`, which Babylon Lite 1.37 made read-only. `setMeshVisible()` also invalidates Lite's cached render bundles, which a plain field write never did. It has been exported since Lite 1.0.1, so the `^1.0.1` peer range is unchanged.
