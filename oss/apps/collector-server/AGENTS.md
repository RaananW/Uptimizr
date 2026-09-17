# AGENTS.md — @uptimizr/collector-server

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The public-facing **ingestion + query API** (Fastify) for the OSS data collector, plus the
`uptimizr` CLI that self-hosts it. All client input is untrusted and validated against
`@uptimizr/schema` at the boundary. Route handlers stay thin; storage lives behind a swappable
`CollectorStore` (ADR 0005).

It is the **single gateway** to the data: the dashboard, `@uptimizr/mcp`, the in-browser assistant
and your own agents all read through this HTTP API, never the database.

## Run it

```bash
# 1. One-time setup: generate a visitor-hash secret, create + migrate the store,
#    mint a first project + API key, write a local .env.
npx -p @uptimizr/collector-server uptimizr init "My Project"

# 2. Start the ingestion + query API (reads the generated .env; 0.0.0.0:4318).
npx -p @uptimizr/collector-server uptimizr serve
```

`init` prints a **`projectId`** (public — give it to your client SDK along with this server's URL)
and a one-time **API key** (secret — `x-api-key` for the query routes).

### CLI (ADR 0029)

| Command                        | What it does                                                         |
| ------------------------------ | -------------------------------------------------------------------- |
| `uptimizr init [name]`         | Secret + store + migrations + first project/key + `.env`.            |
| `uptimizr serve`               | Run the ingestion + query API. The default when no command is given. |
| `uptimizr new-project <name>`  | Mint an additional project + API key.                                |
| `uptimizr new-key <projectId>` | Mint an additional key on an existing project (see the flags below). |
| `uptimizr migrate`             | Apply store migrations.                                              |
| `uptimizr regions set <scene>` | Replace a scene's named regions from `--file <regions.json>`.        |
| `uptimizr regions get <scene>` | Print a scene's named regions as JSON.                               |
| `uptimizr help`                | Usage.                                                               |

`new-key` flags: `--capabilities <list>` (comma-separated; default `query`), `--label <name>`,
and the paired `--rate-limit-max <n>` / `--rate-limit-window-ms <ms>`:

```bash
uptimizr new-key <projectId> --capabilities query,annotate \
  --label "weekly-report-agent" --rate-limit-max 120 --rate-limit-window-ms 60000
```

`regions` commands take `--project <projectId>` (or `UPTIMIZR_PROJECT_ID`). They talk to the store
**directly**, so they need no API key — an operator command, unlike the HTTP equivalent.

**Every command targets the store selected by `COLLECTOR_STORE`**, read through the same
connection variables `serve` uses — so export the store + its settings before `init` and the
project you mint is the one the running collector resolves.

Installed as a dependency, the package exposes the `uptimizr` CLI plus the legacy
`uptimizr-collector` bin (equivalent to `uptimizr serve`).

## API keys and capabilities (ADR 0051 §7)

A key carries a **set of capabilities**, not a single role. Keys default to `query`.

| Capability  | Unlocks                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `query`     | The aggregate analytics API, the scene registry, the live token exchange, and `GET /api/v1/audit`.        |
| `query:raw` | Raw per-session streams: `GET /api/v1/sessions/:id/events` and `GET /api/v1/live/sessions/:id`.           |
| `annotate`  | The project **metadata** write path (annotations, glossary, saved analyses, panel specs). Never events.   |
| `ingest`    | Reserved for server-side write paths. Public ingestion is keyless, so issued keys are normally read keys. |

The raw endpoints are gated **twice**: the collector must run with `ENABLE_RAW_SESSION_RETENTION`
**and** the key must hold `query:raw` — otherwise `403`. Retention alone is not enough.

`--rate-limit-max` / `--rate-limit-window-ms` give a key its own request budget, bucketed on the
**key id** rather than the client IP; keys without one fall back to `COLLECTOR_RATE_LIMIT_*`.
Ingestion keeps its separate `COLLECTOR_INGEST_RATE_LIMIT_*` budget.

## Endpoints an agent should know

- **`GET /api/v1/openapi.json`** — **unauthenticated** OpenAPI 3.1 for the whole read API,
  generated from the `@uptimizr/metrics` registry (ADR 0051) and this server's route table. One
  path per endpoint, the real validating schema per parameter, a response schema per metric, and
  the semantics OpenAPI cannot express as `x-uptimizr-*` extensions (result `grain`, per-column
  `units`, `caveats`, `interpretation`, source capture channels, row `limits`). **Start here**
  rather than guessing routes; generate a typed client with
  `npx openapi-typescript <collector>/api/v1/openapi.json -o collector.d.ts`.
- **`GET /api/v1/whoami`** — the calling key's `projectId`, `keyId`, `capabilities`, `label` and
  effective `rateLimit` (plus `rateLimitSource`: `"key"` or `"default"`). It reports the key's
  **id**, never the key. Call it first and register only the tools your capabilities permit,
  instead of probing for `403`s.
- **`GET /api/v1/audit`** (`since` / `until` / `limit`, any `query` key) — the agent audit log.
- `POST /api/v1/collect` — batched ingestion. **Keyless by design** (it runs in untrusted
  browsers, where a key is not a secret); protected by schema validation, payload bounds and rate
  limits instead. The server sets the cookieless `visitorId = hash(ip + ua + dailySalt)`; the raw
  IP is never stored (ADR 0003).
- The read API: sessions, heatmaps (`pointer`, `camera`, `position`, `world`, `gaze`, `mesh-uv`,
  `click-rays`, `flow`, `perf`, `errors`), mesh/interaction insights, performance and diagnostics,
  scene/path/funnel analytics, scene representations and regions, and the live SSE endpoints.
- `GET /health` — liveness probe, unauthenticated.

### Result envelopes: `format=full | table | summary` (ADR 0051 §2)

Every aggregate endpoint accepts `format`. It **filters nothing** — it picks the result envelope:

- `full` (default) — the bare rows, unchanged. What the dashboard uses.
- `table` — adds a `meta` envelope: metric, range, applied filters, sample size, row count,
  `truncated`, limits.
- `summary` — a bounded digest: ranked top rows, a first/last/min/max/trend series, or merged
  spatial clusters, with shares, the metric's caveats and a templated `reading` sentence, capped at
  the registry's `maxSummaryRows`. **This is what makes a 500-bin heatmap affordable for an LLM** —
  prefer it over `full` when feeding a model.

### Filters

Common query params: `since`, `until` (epoch ms), `bins`, `limit`, `scene`, `session`,
`cameraMode`, `source`, and spatial `cellSize` / **`region`** where supported. `region=<id>` drills
a spatial query into one named place from the scene registry — declare regions with
`uptimizr regions set`, `PUT /api/v1/scenes/:sceneId/regions` (an `annotate` key), or
`registerRegions` in `@uptimizr/sdk-core`.

### Live endpoints

`POST /api/v1/live/token` exchanges a query key for a short-lived SSE token; the key's capability
set is carried **inside the signed token**, so `GET /api/v1/live/sessions/:id` can enforce
`query:raw` even though `EventSource` cannot send headers. `GET /api/v1/live/presence` and
`/live/stream` use the same `?token=...`.

## Storage (`COLLECTOR_STORE`)

| Value                  | Store                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duckdb` **(default)** | Single-file OSS store: events **and** metadata in one file at `DUCKDB_PATH` (default `./data/uptimizr.duckdb`). No external service. **Single-writer** — one collector process per file; back up by copying the file. |
| `memory`               | Dependency-free in-memory store for local dev / E2E only (`COLLECTOR_MEMORY_PROJECT_ID` / `COLLECTOR_MEMORY_API_KEY`).                                                                                                |
| `postgres`             | `@uptimizr/db-postgres` — `POSTGRES_URL` / `DATABASE_URL`, `POSTGRES_SCHEMA`, `POSTGRES_POOL_MAX`. Multi-writer.                                                                                                      |
| `mssql`                | `@uptimizr/db-mssql` — `MSSQL_URL` (or `MSSQL_SERVER` / `MSSQL_PORT` / `MSSQL_DATABASE` / `MSSQL_USER` / `MSSQL_PASSWORD`). SQL Server 2022+ / Azure SQL. Multi-writer.                                               |
| `clickhouse`           | `@uptimizr/db-clickhouse` — `CLICKHOUSE_URL` / `CLICKHOUSE_DATABASE` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`. Concurrent writers, high-volume ingestion.                                                          |

All four return **identical analytics** (the cross-engine parity suite). Aggregations are computed
at **query time** in v1 — no materialized views.

## Other configuration

- Server / browser access: `COLLECTOR_HOST` (`0.0.0.0`), `COLLECTOR_PORT` (`4318`),
  `COLLECTOR_CORS_ORIGINS`, `COLLECTOR_TRUST_PROXY`, `COLLECTOR_BODY_LIMIT`.
- Privacy / replay / live: **`VISITOR_HASH_SECRET` (required — the server fails fast without it)**,
  `ENABLE_RAW_SESSION_RETENTION`, `LIVE_TOKEN_SECRET`, `LIVE_TOKEN_TTL_MS`, `LIVE_WINDOW_MS`,
  `LIVE_MAX_CONNECTIONS`, `LIVE_PRESENCE_INTERVAL_MS`.
- Rate limits: `COLLECTOR_RATE_LIMIT_MAX`, `COLLECTOR_RATE_LIMIT_WINDOW_MS`,
  `COLLECTOR_INGEST_RATE_LIMIT_MAX`, `COLLECTOR_INGEST_RATE_LIMIT_WINDOW_MS`.
- Agent audit: **`AUDIT_RETENTION_DAYS`** (default `30`; `0` = keep forever),
  `AUDIT_DASHBOARD_REQUESTS` (default off — requests carrying `x-uptimizr-client: dashboard` are
  skipped as a volume filter, **not** a security boundary).
- All-in-one dashboard: `COLLECTOR_DASHBOARD_DIR` (point it at a static dashboard export and one
  process serves ingestion, queries and the UI), `COLLECTOR_CSP` (`strict` or `off`).

## Rules for agents

- **Validate at the boundary.** Every request body and querystring is parsed against
  `@uptimizr/schema` / the metric registry. Never trust client input, never skip validation.
- **Keep handlers thin** (ADR 0005). Aggregation logic belongs in `@uptimizr/db`; the semantics of
  a metric belong in `@uptimizr/metrics`. A new read endpoint is a **registry entry**, not a
  hand-written route — `registryRoutes.test.ts` asserts the endpoint exists and that its
  querystring keys equal the metric's `filters`, and `queryResponseSchemas.test.ts` asserts every
  endpoint's rows parse against the metric's `row` schema on a seeded store, an empty one, and the
  in-memory store.
- **Never weaken the raw-data gate.** `ENABLE_RAW_SESSION_RETENTION` **and** `query:raw`, both,
  for `/sessions/:id/events` and `/live/sessions/:id` (ADR 0003).
- **Never log secrets or raw IPs.** The audit log's subject is the key **id**; `params` drops
  credential-shaped fields and is capped at 512 bytes. Audit writes happen after the response is
  flushed, so they can never block or fail a request. Refusals are recorded too.
- **Ingestion stays keyless.** Do not "fix" it by requiring a key — a key shipped to an untrusted
  browser is not a secret. Harden with validation, payload bounds, rate limits and CORS instead.
- Events live once in `@uptimizr/schema`. Do not redefine an event shape here.
- Aggregations are query-time in v1; do not add materialized views without an ADR.

## Develop

```bash
pnpm --filter @uptimizr/collector-server dev    # tsx watch
pnpm --filter @uptimizr/collector-server test   # vitest (app.inject() + a fake store)
pnpm --filter @uptimizr/collector-server build
```

Tests run against a fake `CollectorStore` with `app.inject()` — no live database required.

## More

- Package reference: [README.md](./README.md)
- HTTP API reference:
  https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md#4-http-api
- Query API guide: https://uptimizr.com/docs/api/query/
- Deploy guide: https://uptimizr.com/docs/deploy/collector/
