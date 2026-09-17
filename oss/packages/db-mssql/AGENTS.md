# AGENTS.md — @uptimizr/db-mssql

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The optional **single-tenant Microsoft SQL Server store** for the Uptimizr collector — for
self-hosters standardized on SQL Server / Azure SQL who want a familiar, **multi-writer**
relational backend instead of the default single-file DuckDB store (ADR 0020).

It is a **re-home + dialect emitter, not a rewrite**. Every analytics aggregation is authored once
in [`@uptimizr/db`](../db) against the dialect-agnostic query layer
(`buildX(projectId, opts, dialect)` → `QuerySpec`) and rendered to T-SQL with the shared
`mssqlDialect` / `toTsql` (also
exported from `@uptimizr/db`). This package adds a pooled
[`mssql`](https://github.com/tediousjs/node-mssql) (tedious) client, forward-only migrations, and
metadata helpers that satisfy the same `CollectorStore` contract as DuckDB, ClickHouse and
Postgres.

Server/Node only — no DOM imports. Single-tenant only: no `org_id`, no tenant isolation.
**SQL Server 2022 (16.x) or Azure SQL** is required (`GREATEST` / `LEAST`; the rest is 2016+).

## Install / select it

The collector picks a store with `COLLECTOR_STORE`:

```bash
COLLECTOR_STORE=mssql \
MSSQL_URL="Server=localhost,1433;Database=uptimizr;User Id=sa;Password=…;Encrypt=true;TrustServerCertificate=true" \
  npx -p @uptimizr/collector-server uptimizr serve
```

| Variable                                           | Purpose                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MSSQL_URL`                                        | ADO.NET-style connection string (`Server=host,port;Database=…;User Id=…;Password=…;Encrypt=…`). Wins when set.      |
| `MSSQL_SERVER` / `MSSQL_PORT`                      | Host / port when `MSSQL_URL` is unset (default `localhost` / `1433`).                                               |
| `MSSQL_DATABASE`                                   | Database (default `uptimizr`). Created on first boot when the login has `CREATE ANY DATABASE`.                      |
| `MSSQL_USER` / `MSSQL_PASSWORD`                    | SQL login (default `sa`; `MSSQL_SA_PASSWORD` — the variable the SQL Server image reads — is the password fallback). |
| `MSSQL_ENCRYPT` / `MSSQL_TRUST_SERVER_CERTIFICATE` | TLS on (default `true`, as Azure SQL requires) / trust a self-signed certificate (default `false`).                 |
| `MSSQL_POOL_MAX`                                   | Maximum pooled connections per collector process (default `10`).                                                    |

Migrations run on store creation — idempotent, forward-only (ADR 0007) and serialized behind an
application lock (`sp_getapplock`), so several collector instances may boot concurrently against
one database.

`uptimizr init` / `new-project` / `new-key` / `migrate` / `regions` all honour `COLLECTOR_STORE`,
so export the store + connection variables before running them and the project you mint lives in
SQL Server. A local SQL Server is available from [`infra/docker`](../../../infra/docker)
(`pnpm stack:up`).

## Canonical usage

```ts
import {
  createMssqlClient,
  migrateMssql,
  insertEvents,
  getSessionEvents,
  resolveApiKey,
  runMssqlQuery,
} from "@uptimizr/db-mssql";
import { buildPointerHeatmap, mssqlDialect, type HeatmapBinRow } from "@uptimizr/db";

const db = createMssqlClient(settings);
await migrateMssql(db);

await insertEvents(db, events); // validated upstream at the collector boundary
const heat = await runMssqlQuery<HeatmapBinRow>(
  db,
  buildPointerHeatmap("project-id", { bins: 50 }, mssqlDialect),
);
```

The `CollectorStore` itself is assembled from these building blocks in the collector server
(`oss/apps/collector-server/src/mssqlStore.ts`, `createMssqlStore`) — this package stays a
store-agnostic toolkit.

## Rules for agents

- **Never author an aggregation here.** A new aggregation is a pure
  `buildX(projectId, opts, dialect)` builder in `@uptimizr/db` plus a `@uptimizr/metrics` registry
  entry. This package only renders and runs.
- **Migrations are forward-only, additive and idempotent** (ADR 0007). Append to
  `MSSQL_MIGRATIONS`; never edit a shipped migration. Keep the `sp_getapplock` serialization so
  concurrent collector boots stay safe.
- `runMssqlQuery` must run `toTsql`, rewrite named params to positional (`toPositionalParams`),
  and call `coerceRows(spec.metric, rows)` at the one point rows leave the driver (ADR 0051 §2).
  `null` stays `null`: an aggregate over an empty set is "no samples", not `0`.
- T-SQL lacks three things the shared SQL assumes, and every workaround lives in the **shared**
  dialect, not per query: no array type (vectors are JSON arrays read via `mssqlVectorElement`),
  no `ASOF JOIN` (`renderNearestRowJoin` as `CROSS APPLY` / `OUTER APPLY`), and no aggregate
  percentile (`STRING_AGG` + the migration-created `dbo.uptimizr_quantile` scalar function).
  `toTsql` also rewrites `LIMIT` and `GROUP BY <alias>`.
- Every string column and JSON extraction uses the binary collation `Latin1_General_100_BIN2` so
  comparisons, `GROUP BY` and ordering stay case-sensitive and code-point ordered like the other
  engines. Do not drop the collation.
- Averaged inputs must be `float` — integer `AVG` truncates in T-SQL.
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
  database or table name from input.
- Correctness is identical to the other engines; **cost is not**. JSON-per-row vector reads,
  per-row `APPLY` lookups and packed percentiles make this the slowest engine on spatial heatmaps.
  For high-volume ranges recommend `@uptimizr/db-clickhouse` rather than tuning around it here.

## Tests and parity

`dialect.test.ts` is a pure unit suite (no server): dialect fragments, the `toTsql` rewrites, and
that every parity query renders free of the constructs T-SQL rejects. `mssqlParity.test.ts` /
`mssqlStore.test.ts` probe the server behind `MSSQL_URL` (or the `MSSQL_*` variables) first and
**skip when no server is reachable**, so the default `pnpm test` stays Docker-free; they create
throwaway databases and drop them on teardown. Set **`MSSQL_PARITY_REQUIRED=1`** to fail instead
of skipping — that is what the "Store parity (MSSQL)" CI job does (`pnpm test:parity:mssql` runs
them locally with `.env` loaded).

## More

- Package reference: [README.md](./README.md)
- Storage contracts + dialect layer: [`@uptimizr/db`](../db/AGENTS.md)
- Collector configuration: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
