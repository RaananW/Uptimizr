# `oss/` — Open-source Uptimizr (Apache-2.0)

The self-hostable 3D analytics product. Everything here is Apache-2.0 licensed and designed
to be extractable into a standalone repository.

> **Separation rule:** packages in `oss/` are Apache-2.0 and self-contained; keep storage details
> behind the `@uptimizr/db` contracts so the store stays swappable.

## Apps

- [`apps/collector-server`](./apps/collector-server) — Fastify ingestion + query API.
- [`apps/dashboard`](./apps/dashboard) — Next.js + Tailwind analytics dashboard.

## Packages

- [`packages/schema`](./packages/schema) — `@uptimizr/schema`: Zod event contracts + TS types.
- [`packages/sdk-core`](./packages/sdk-core) — `@uptimizr/sdk-core`: transport, batching, session, cookieless.
- [`packages/sdk-babylon`](./packages/sdk-babylon) — `@uptimizr/babylon`: Babylon.js collector adapter.
- [`packages/replay`](./packages/replay) — `@uptimizr/replay`: re-drive a session in the user's own scene.
- [`packages/db`](./packages/db) — `@uptimizr/db`: ClickHouse + Postgres clients and migrations.

See [docs/architecture/overview.md](../docs/architecture/overview.md) for how these fit together.
