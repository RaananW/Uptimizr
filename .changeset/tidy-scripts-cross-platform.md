---
"@uptimizr/aframe": patch
"@uptimizr/agent-core": patch
"@uptimizr/babylon": patch
"@uptimizr/babylon-lite": patch
"@uptimizr/collector-server": patch
"@uptimizr/dashboard": patch
"@uptimizr/db": patch
"@uptimizr/db-clickhouse": patch
"@uptimizr/db-mssql": patch
"@uptimizr/db-postgres": patch
"@uptimizr/godot": patch
"@uptimizr/heatmap": patch
"@uptimizr/mcp": patch
"@uptimizr/playcanvas": patch
"@uptimizr/r3f": patch
"@uptimizr/react": patch
"@uptimizr/replay": patch
"@uptimizr/schema": patch
"@uptimizr/sdk-core": patch
"@uptimizr/three": patch
"@uptimizr/unity": patch
"@uptimizr/unreal": patch
"@uptimizr/web-export": patch
---

Make the package scripts cross-platform so a fresh Windows checkout can build. `clean` now uses `rimraf` instead of `rm -rf`, and the dashboard's `build`/`build:static`/`prepack`/`start` no longer rely on a POSIX `VAR=value` prefix. No runtime or published-output change.
