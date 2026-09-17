# AGENTS.md — @uptimizr/db-postgres

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The optional **single-tenant PostgreSQL store** for the Uptimizr collector — for self-hosters who
already run Postgres and want a familiar, **multi-writer** relational backend instead of the
default single-file DuckDB store (ADR 0020).

It is a **re-home + dialect emitter, not a rewrite**. Every analytics aggregation is authored once
in [`@uptimizr/db`](../db) against the dialect-agnostic query layer
(`buildX(projectId, opts, dialect)` → `QuerySpec`) and rendered to Postgres SQL with the shared
`postgresDialect` (also
exported from `@uptimizr/db`). This package adds a pooled [`pg`](https://node-postgres.com)
client, forward-only migrations, and metadata helpers that satisfy the same `CollectorStore`
contract as DuckDB and ClickHouse.

Server/Node only — no DOM imports. Single-tenant only: no `org_id`, no tenant isolation.

## Install / select it

The collector picks a store with `COLLECTOR_STORE`:

```bash
COLLECTOR_STORE=postgres \
POSTGRES_URL=postgresql://uptimizr:uptimizr@localhost:5432/uptimizr \
  npx -p @uptimizr/collector-server uptimizr serve
```

| Variable                           | Purpose                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `POSTGRES_URL` (or `DATABASE_URL`) | libpq connection URI (`?sslmode=require` etc. apply). The database must already exist. |
| `POSTGRES_SCHEMA`                  | Schema the store's tables live in (default `public`; created on first boot).           |
| `POSTGRES_POOL_MAX`                | Maximum pooled connections per collector process (default `10`).                       |

Migrations run on store creation — idempotent, forward-only (ADR 0007) and serialized behind an
advisory lock, so several collector instances may boot concurrently against one database.
Postgres 14+ is supported (tested against 16).

`uptimizr init` / `new-project` / `new-key` / `migrate` / `regions` all honour `COLLECTOR_STORE`,
so export the store + connection variables before running them and the project you mint lives in
Postgres. A local Postgres is available from [`infra/docker`](../../../infra/docker)
(`pnpm stack:up`).

## Canonical usage

```ts
import {
  createPostgresClient,
  migratePostgres,
  insertEvents,
  getSessionEvents,
  resolveApiKey,
  runPostgresQuery,
} from "@uptimizr/db-postgres";
import { buildPointerHeatmap, postgresDialect, type HeatmapBinRow } from "@uptimizr/db";

const db = createPostgresClient(settings);
await migratePostgres(db);

await insertEvents(db, events); // validated upstream at the collector boundary
const heat = await runPostgresQuery<HeatmapBinRow>(
  db,
  buildPointerHeatmap("project-id", { bins: 50 }, postgresDialect),
);
```

The `CollectorStore` itself is assembled from these building blocks in the collector server
(`oss/apps/collector-server/src/postgresStore.ts`, `createPostgresStore`) — this package stays a
store-agnostic toolkit.

## Rules for agents

- **Never author an aggregation here.** A new aggregation is a pure
  `buildX(projectId, opts, dialect)` builder in `@uptimizr/db` plus a `@uptimizr/metrics` registry
  entry. This package only renders and runs.
- **Migrations are forward-only, additive and idempotent** (ADR 0007). Append to
  `POSTGRES_MIGRATIONS`; never edit a shipped migration. Keep the advisory lock so concurrent
  collector boots stay safe.
- `runPostgresQuery` must call `coerceRows(spec.metric, rows)` at the one point rows leave the
  driver (ADR 0051 §2) — `pg` hands back `int8` / `numeric` as strings. `null` stays `null`: an
  aggregate over an empty set is "no samples", not `0`.
- Postgres has no `ASOF JOIN` and no MergeTree rollups; both are already closed at the **shared**
  layer (`renderNearestRowJoin` and plain query-time `perf_daily` / `events_daily` views). Reuse
  those helpers rather than hand-writing a per-query workaround.
- Validate events upstream at the collector boundary; this layer assumes valid input.
- API keys are only ever stored as **SHA-256 hashes** — never persist a raw key. Read capability
  sets with `parseApiKeyCapabilities` and write them with `toApiKeyColumns` (from `@uptimizr/db`)
  so ordering, validation and the per-key rate-limit columns stay consistent across engines.
- **The audit log records key ids, never keys.** Serialize parameters with `serializeAuditParams`
  and clamp the endpoint with `clampAuditTool` before they reach `recordAudit`.
- Privacy (ADR 0003): no raw IPs, no PII. Raw per-session reads are gated by the collector's
  `ENABLE_RAW_SESSION_RETENTION` **and** a `query:raw` capability — do not add a bypass here.
- **Parity is the contract.** The shared `PARITY_EVENTS` / `PARITY_CASES` / `diffParity` harness in
  `@uptimizr/db` proves every engine returns equal analytics. Extend the fixtures and golden when
  you add an aggregation or event type, and document any genuine divergence.
- Identifiers interpolated into DDL go through `assertSafeIdentifier` — never string-concatenate a
  schema or table name from input.

## Tests and parity

`dialect.test.ts` is a pure unit suite (no server). `postgresParity.test.ts` /
`postgresStore.test.ts` probe `POSTGRES_URL` (or `DATABASE_URL`) first and **skip when no server is
reachable**, so the default `pnpm test` stays Docker-free; they use throwaway schemas dropped on
teardown. Set **`POSTGRES_PARITY_REQUIRED=1`** to fail instead of skipping — that is what the
"Store parity (Postgres)" CI job does (`pnpm test:parity:postgres` runs them locally with `.env`
loaded).

## More

- Package reference: [README.md](./README.md)
- Storage contracts + dialect layer: [`@uptimizr/db`](../db/AGENTS.md)
- Collector configuration: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
