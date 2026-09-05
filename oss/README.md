# `oss/` — Open-source Uptimizr (Apache-2.0)

The self-hostable 3D analytics product. Everything here is Apache-2.0 licensed and designed
to be extractable into a standalone repository.

> **Separation rule:** packages in `oss/` are Apache-2.0 and self-contained; keep storage details
> behind the `@uptimizr/db` contracts so the store stays swappable.

## Apps

- [`apps/collector-server`](./apps/collector-server) — Fastify ingestion + query API.
- [`apps/dashboard`](./apps/dashboard) — Next.js + Tailwind analytics dashboard.
- [`apps/demo`](./apps/demo) — backend-less, in-browser DuckDB-Wasm test drive.
- [`apps/docs`](./apps/docs) — Astro Starlight documentation site.
- [`apps/web`](./apps/web) — Astro marketing site.

## Packages

- [`packages/schema`](./packages/schema) — `@uptimizr/schema`: Zod event contracts + TS types.
- [`packages/sdk-core`](./packages/sdk-core) — `@uptimizr/sdk-core`: transport, batching, session, cookieless.
- [`packages/replay`](./packages/replay) — `@uptimizr/replay`: re-drive a session in the user's own scene.
- [`packages/react`](./packages/react) — `@uptimizr/react`: embeddable React analytics panels and shared collector client.
- [`packages/heatmap`](./packages/heatmap) — `@uptimizr/heatmap`: framework-agnostic 3D heatmap overlay core.
- [`packages/mcp`](./packages/mcp) — `@uptimizr/mcp`: read-only MCP server over the collector query API.
- [`packages/create-uptimizr`](./packages/create-uptimizr) — `create-uptimizr`: self-host scaffolding CLI.
- [`packages/db`](./packages/db) — `@uptimizr/db`: storage contracts, dialect-agnostic query layer, and DuckDB store.
- [`packages/db-clickhouse`](./packages/db-clickhouse) — `@uptimizr/db-clickhouse`: optional ClickHouse store.
- [`packages/sdk-babylon`](./packages/sdk-babylon) — `@uptimizr/babylon`: Babylon.js collector adapter.
- [`packages/sdk-babylon-lite`](./packages/sdk-babylon-lite) — `@uptimizr/babylon-lite`: Babylon Lite collector adapter.
- [`packages/sdk-three`](./packages/sdk-three) — `@uptimizr/three`: three.js collector adapter.
- [`packages/sdk-r3f`](./packages/sdk-r3f) — `@uptimizr/r3f`: react-three-fiber collector adapter.
- [`packages/sdk-playcanvas`](./packages/sdk-playcanvas) — `@uptimizr/playcanvas`: PlayCanvas collector adapter.
- [`packages/sdk-aframe`](./packages/sdk-aframe) — `@uptimizr/aframe`: A-Frame / WebXR collector adapter.
- [`packages/web-export`](./packages/web-export) — `@uptimizr/web-export`: shared foundation for WebAssembly engine exports (JS-only tier + versioned engine bridge + native-frame normalization).
- [`packages/unity`](./packages/unity) — `@uptimizr/unity`: Unity WebGL export connector.
- [`packages/godot`](./packages/godot) — `@uptimizr/godot`: Godot 4 Web export connector.
- [`packages/unreal`](./packages/unreal) — `@uptimizr/unreal`: Unreal web export connector (best-effort).

See [docs/architecture/overview.md](../docs/architecture/overview.md) for how these fit together.
