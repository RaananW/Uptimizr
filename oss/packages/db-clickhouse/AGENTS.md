# AGENTS.md — @uptimizr/db-clickhouse

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The optional **single-tenant ClickHouse store** for the Uptimizr collector — the scale path for
self-hosters who outgrow the default single-file DuckDB store and need concurrent, high-volume
ingestion (ADR 0020).

It is a **re-home + dialect emitter, not a rewrite**. Every analytics aggregation is authored once
in [`@uptimizr/db`](../db) against the dialect-agnostic query layer
(`buildX(projectId, opts, dialect)` → `QuerySpec`) and rendered to ClickHouse SQL with the shared
`clickhouseDialect` (also
exported from `@uptimizr/db`). This package adds a ClickHouse client, forward-only migrations, and
metadata helpers that satisfy the same `CollectorStore` contract as DuckDB.

Server/Node only — no DOM imports. Single-tenant only: no `org_id`, no tenant isolation.

## Install / select it

The collector picks a store with `COLLECTOR_STORE`:

```bash
COLLECTOR_STORE=clickhouse \
CLICKHOUSE_URL=http://localhost:8123 \
CLICKHOUSE_DATABASE=uptimizr \
CLICKHOUSE_USER=default \
CLICKHOUSE_PASSWORD= \
  npx -p @uptimizr/collector-server uptimizr serve
```

Connection settings are read from the environment through `readDbSettings().clickhouse` in
`@uptimizr/db`. The schema is migrated on store creation, so it works out of the box. For a
managed ClickHouse, point `CLICKHOUSE_URL` at the HTTPS endpoint (`https://<host>:8443`) — TLS is
inferred from the scheme; the connecting user needs `CREATE DATABASE`, or the database must
already exist. Custom CA bundles / mutual-TLS client certs are not currently exposed.

`uptimizr init` / `new-project` / `new-key` / `migrate` / `regions` all honour `COLLECTOR_STORE`,
so export the store + connection variables before running them and the project you mint lives in
ClickHouse.

A local ClickHouse is available from [`infra/docker`](../../../infra/docker) (`pnpm stack:up`).

## Canonical usage

```ts
import {
  createClickhouseClient,
  migrateClickhouse,
  insertEvents,
  getSessionEvents,
  resolveApiKey,
  runClickhouseQuery,
} from "@uptimizr/db-clickhouse";
import { buildPointerHeatmap, clickhouseDialect, type HeatmapBinRow } from "@uptimizr/db";

const db = createClickhouseClient(settings);
await migrateClickhouse(db);

await insertEvents(db, events); // validated upstream at the collector boundary
const heat = await runClickhouseQuery<HeatmapBinRow>(
  db,
  buildPointerHeatmap("project-id", { bins: 50 }, clickhouseDialect),
);
```

The `CollectorStore` itself is assembled from these building blocks in the collector server
(`oss/apps/collector-server/src/clickhouseStore.ts`, `createClickhouseStore`) — this package stays
a store-agnostic toolkit.

## Rules for agents

- **Never author an aggregation here.** A new aggregation is a pure
  `buildX(projectId, opts, dialect)` builder in `@uptimizr/db` plus a `@uptimizr/metrics` registry
  entry. This package only renders and runs.
- **Migrations are forward-only, additive and idempotent** (ADR 0007). Append to
  `CLICKHOUSE_MIGRATIONS`; never edit a shipped migration.
- `runClickhouseQuery` must call `coerceRows(spec.metric, rows)` at the one point rows leave the
  driver (ADR 0051 §2), so string-encoded 64-bit integers and decimals reach consumers as JS
  numbers. `null` stays `null` — an aggregate over an empty set is "no samples", not `0`.
- Validate events upstream at the collector boundary; this layer assumes valid input.
- API keys are only ever stored as **SHA-256 hashes** — never persist a raw key. Read capability
  sets with `parseApiKeyCapabilities` and write them with `toApiKeyColumns` (from `@uptimizr/db`)
  so ordering, validation and the per-key rate-limit columns stay consistent across engines.
- **The audit log records key ids, never keys.** Serialize parameters with `serializeAuditParams`
  and clamp the endpoint with `clampAuditTool` before they reach `recordAudit`.
- Privacy (ADR 0003): no raw IPs, no PII. Raw per-session reads are gated by the collector's
  `ENABLE_RAW_SESSION_RETENTION` **and** a `query:raw` capability — do not add a bypass here.
- **Parity is the contract.** The shared `PARITY_EVENTS` / `PARITY_CASES` / `diffParity` harness in
  `@uptimizr/db` proves DuckDB and ClickHouse return equal analytics. Extend the fixtures and
  golden when you add an aggregation or event type.

## Tests and parity

`src/__tests__/clickhouseParity.test.ts` and the scene-region suite probe the server at
`CLICKHOUSE_URL` and **skip when nothing is reachable**, so the default `pnpm test` stays
Docker-free. Set **`CLICKHOUSE_PARITY_REQUIRED=1`** to turn an unreachable server into a failure —
that is what the "Store parity (ClickHouse)" CI job does (`pnpm test:parity:clickhouse` runs the
suite locally with `.env` loaded).

## More

- Package reference: [README.md](./README.md)
- Storage contracts + dialect layer: [`@uptimizr/db`](../db/AGENTS.md)
- Collector configuration: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
