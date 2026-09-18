# @uptimizr/collector-server

The public-facing **ingestion + query API** (Fastify) for the OSS data-collector.
All client input is untrusted and validated against [`@uptimizr/schema`](../../packages/schema)
at the boundary. Route handlers stay thin; storage logic lives in
[`@uptimizr/db`](../../packages/db) behind a swappable `CollectorStore`.

## Self-host (npm)

Run the collector straight from npm — no repo clone, no Docker, no external
database (the OSS default store is a single DuckDB file). The store is
created and migrated automatically.

```bash
# 1. One-time setup: generates a visitor-hash secret, creates + migrates the
#    store (DuckDB by default), mints a first project + owner API key, and
#    writes a local .env.
npx -p @uptimizr/collector-server uptimizr init "My Project"

# 2. Start the ingestion + query API (reads the generated .env; 0.0.0.0:4318).
npx -p @uptimizr/collector-server uptimizr serve
```

`init` prints a **`projectId`** and a one-time **API key**. Give the `projectId`
and this server's URL (the **`endpoint`**) to your client SDK (e.g.
`@uptimizr/babylon`); use the **API key** (`x-api-key`) for the query routes /
dashboard. That first key is the operator's **owner** key — `query`, `query:raw`
and `annotate` — so the dashboard, session replay, the live per-session follow
and scene regions all work off it; hand agents and MCP clients a narrower key of
their own with `uptimizr new-key`. Mint more projects later with
`npx -p @uptimizr/collector-server uptimizr new-project "<name>"`, or add a key
to an existing project with
`npx -p @uptimizr/collector-server uptimizr new-key <projectId> [--capabilities …] [--label …]`
— see [API keys and capabilities](#api-keys-and-capabilities).

`init`, `new-project` and `migrate` target the store selected by
`COLLECTOR_STORE`, read through the same connection variables `serve` uses — so
to self-host on Postgres, SQL Server or ClickHouse instead of DuckDB, export the
store and its connection settings before running them (see
[Configuration](#configuration)), or let `npm create uptimizr@latest -- --store <s>`
generate the `.env` for you:

```bash
export COLLECTOR_STORE=postgres
export POSTGRES_URL=postgresql://uptimizr:uptimizr@localhost:5432/uptimizr
npx -p @uptimizr/collector-server uptimizr init "My Project"   # schema + first project live in Postgres
npx -p @uptimizr/collector-server uptimizr serve
```

### Naming places in a scene: `uptimizr regions`

A scene can carry **regions** — named, labelled world-space boxes ("the
entrance", "the checkout counter") that give spatial results a vocabulary and let
any spatial query be drilled into a place with `?region=<id>`. Declare them from
a JSON file straight against the store, without a running collector:

```bash
cat > regions.json <<'JSON'
[
  { "id": "entrance", "label": "Entrance", "bounds": [-5, 0, -5, 5, 3, 0] },
  { "id": "counter", "label": "Checkout counter", "bounds": [-1, 0, 1, 1, 2, 3] }
]
JSON

npx -p @uptimizr/collector-server uptimizr regions set lobby --file regions.json --project "$PROJECT_ID"
npx -p @uptimizr/collector-server uptimizr regions get lobby --project "$PROJECT_ID"
```

The file is either a bare array or the `{ "regions": [...] }` envelope the HTTP
endpoint takes, so one file works with both. `--project` may be replaced by
`UPTIMIZR_PROJECT_ID`. The write **replaces** the scene's whole set, so leaving a
region out removes it and `[]` clears them. The CLI talks to the store directly,
so it needs no API key. Over HTTP the same thing is
`PUT /api/v1/scenes/:sceneId/regions` (see the integration guide), which takes
an `annotate`-capable key, and from a client build `registerRegions` in
`@uptimizr/sdk-core`.

### Scheduled reports: `uptimizr agent report`

Run a read-only analytics agent **once** and write a Markdown report — a weekly
scene-health digest with nobody in the chair. It is an ordinary CLI process that
reads this collector's query API with an ordinary key, so the collector itself
gains no LLM loop and scheduling stays yours (cron, a systemd timer, a GitHub
Action).

```bash
# The narrow key a report should hold
npx -p @uptimizr/collector-server uptimizr new-key <projectId> \
  --capabilities query --label "weekly-report"

export UPTIMIZR_COLLECTOR_URL=https://collect.example.com
export UPTIMIZR_API_KEY=utk_…            # the query-only key above
export UPTIMIZR_AGENT_API_KEY=sk-ant-…   # your own provider key

npx -p @uptimizr/collector-server uptimizr agent report \
  --skill weekly_scene_health --scene lobby --window 7d \
  --out report.md --json report.json --webhook https://hooks.example.com/uptimizr
```

- `--list-skills` prints the investigations this release ships
  (`weekly_scene_health`, `attention_hotspots`, `xr_comfort_review`) and the
  metrics each one reads — the same curated methodologies `@uptimizr/mcp` offers
  as prompts.
- `--dry-run` prints the exact prompt and tool list and calls no provider;
  `UPTIMIZR_AGENT_PROVIDER=scripted` runs the whole path with no model, no key
  and no egress (useful in CI — it produces data, not analysis).
- Provider configuration is read from the environment only and never persisted:
  `UPTIMIZR_AGENT_PROVIDER` (`anthropic` | `openai` | `scripted`),
  `UPTIMIZR_AGENT_MODEL`, `UPTIMIZR_AGENT_API_KEY`, `UPTIMIZR_AGENT_ENDPOINT`.
  The key is never logged, echoed or written into a report.
- Webhook deliveries are signed with
  `X-Uptimizr-Signature: sha256=<hex HMAC-SHA-256 of the raw body>` keyed with
  `UPTIMIZR_WEBHOOK_SECRET`, plus a unique `X-Uptimizr-Delivery` id.
- Exit codes: `0` success · `1` usage/configuration · `2` provider or delivery
  failure · `3` report produced but incomplete (a tool call failed, or no answer).

Every report ends with a **Method** section listing each tool call and its
arguments, so an unattended, model-written document stays auditable. See
`uptimizr agent report --help`, or the
[deploy guide](https://uptimizr.com/docs/deploy/collector/#scheduled-agent-reports)
for a copy-pasteable weekly GitHub Actions workflow.

### All-in-one: serve the dashboard too

The collector can also serve a pre-built static dashboard from its own origin, so
a single process handles ingestion, queries, **and** the UI:

```bash
# Build the dashboard as a static bundle (emits oss/apps/dashboard/out).
pnpm --filter @uptimizr/dashboard build:static

# Point the collector at it and start (relative paths are resolved from CWD).
export COLLECTOR_DASHBOARD_DIR="./oss/apps/dashboard/out"
npx -p @uptimizr/collector-server uptimizr serve
```

The dashboard then loads at the collector's URL (e.g. `http://localhost:4318`) and
defaults its collector target to that same origin — no build-time URL to bake.
Deep links (`/projects/:id/...`) are served the SPA entry so refresh / shared
links resolve. Leave `COLLECTOR_DASHBOARD_DIR` unset to keep the collector
headless.

### Manual setup (without the CLI)

Prefer to wire it yourself? The CLI is optional — set the environment directly:

```bash
# A daily-rotating secret for the cookieless visitor hash is REQUIRED.
export VISITOR_HASH_SECRET="$(openssl rand -hex 32)"
# Browser origins allowed to call the collector (your 3D app + any tools):
export COLLECTOR_CORS_ORIGINS="https://your-app.example.com"
# Where the DuckDB file lives (created if missing):
export DUCKDB_PATH="./uptimizr.duckdb"

# Mint a project + API key (prints PROJECT_ID and a utk_… key once).
npx -p @uptimizr/db uptimizr-db-new-project "My Project"

# Start the ingestion + query API (defaults to 0.0.0.0:4318).
npx -p @uptimizr/collector-server uptimizr-collector
```

Full configuration is in [Configuration](#configuration) below. For a production
deployment, run a single instance behind your own TLS / reverse proxy and persist
the DuckDB file on a volume (DuckDB is single-writer — one collector process per
file; back up by copying the file).

> Installing as a dependency instead of via `npx`? `npm install @uptimizr/collector-server`
> exposes the `uptimizr` CLI (`init` / `serve` / `new-project` / `migrate`) plus
> the legacy `uptimizr-collector` bin; `@uptimizr/db` exposes the DuckDB-only
> `uptimizr-db-new-project` / `uptimizr-db-migrate`.

## Endpoints

### Self-description

- `GET /api/v1/openapi.json` — an **OpenAPI 3.1** document for the whole read API,
  generated from the semantic metric registry (ADR 0051) and this server's own
  route table: one path per endpoint, every parameter carrying the schema that
  actually validates it, and a response schema per metric. The semantics OpenAPI
  cannot express ride along as `x-uptimizr-*` extensions — the result `grain`,
  per-column `units`, `caveats`, `interpretation`, the capture channels that feed
  the metric, and its row `limits`. **Unauthenticated**: it is documentation and
  contains no project data. Generate a typed client with
  `npx openapi-typescript <collector>/api/v1/openapi.json -o collector.d.ts`.

### Ingestion

- `POST /api/v1/collect` — accepts a batched `collectRequest`. Validates → rejects
  mixed-project or unknown-project batches → enriches (server-set cookieless
  `visitorId = hash(ip + ua + dailySalt)`, raw IP never stored) → inserts into the
  configured `CollectorStore` (DuckDB by default) and publishes the live feed.

### Query (require `x-api-key`)

Aggregations are computed **at query time** (v1) — including the heatmap/perf
aggregates, which run directly in the OSS DuckDB store. Every route is scoped to
the project the API key resolves to.

- Sessions: `GET /api/v1/sessions`, `GET /api/v1/sessions/:id/meta`,
  `GET /api/v1/sessions/:id/trajectory`.
- Heatmaps: `GET /api/v1/heatmaps/pointer`, `/camera`, `/position`, `/world`
  (+ `/world/stats`), `/gaze` (+ `/gaze/stats`), `/mesh-uv`, `/click-rays`,
  `/flow`, `/perf`, `/errors`.
- Mesh / interaction insights: `GET /api/v1/meshes/top`, `/sources`, `/trend`,
  `/dwell`, `/blind-spots`, `/kinds`, `/reachability`, plus `/clicks/dead`,
  `/clicks/rage`, `/hover/dwell`, `/camera-gestures`, `/interactions/sources`,
  `/input-actions/top`.
- Performance / diagnostics: `GET /api/v1/perf`, `/perf/compile-stalls`,
  `/perf/render-scale`, `/perf/resources`, `/perf/distribution`,
  `/perf/fps-histogram`, `/perf/frame-time`, `/perf/jank`, `/perf/churn`,
  `/perf/by-device`, `/perf/by-scene`, `/perf/resource-percentiles`,
  `/perf/stability`, `/graphics-diagnostics`, `/rendering-technology`,
  `/capabilities`.
- Scene / path / funnel analytics: `GET /api/v1/scenes`, `/scene-representations`,
  `/timeseries`, `/event-counts`, `/coverage`, `/coverage/view-histogram`,
  `/paths`, `/camera/distance`, `/navigation`, `/backtrack`, `/funnel`,
  `/scene-retention`, `/load-bounce`, `/variant-leaderboard`, `/xr/rotation`,
  `/xr/sources`, `/xr/abandonment`, `/xr/locomotion`.
- Scene representations: `PUT /api/v1/scenes/:sceneId/representation`,
  `GET /api/v1/scenes/:sceneId/representation`.
- `GET /api/v1/sessions/:id/events` — ordered replay timeline. Raw per-session
  data, so it is **gated twice**: `ENABLE_RAW_SESSION_RETENTION` must be on
  **and** the key must hold `query:raw` (`403` otherwise). Supports buffered JSON
  or NDJSON streaming (`Accept: application/x-ndjson` / `?format=ndjson`).
- Key identity + audit: `GET /api/v1/whoami` (the calling key's project, key id,
  capabilities, label and effective rate limit) and `GET /api/v1/audit`
  (`since`/`until`/`limit`) — see
  [API keys and capabilities](#api-keys-and-capabilities).

Live endpoints:

- `POST /api/v1/live/token` — exchange a query API key for a short-lived live
  token. The key's capability set is carried inside the signed token, so the
  per-session follow can enforce `query:raw` without a header `EventSource`
  cannot send.
- `GET /api/v1/live/presence`, `/live/stream`, `/live/sessions/:id` — SSE streams
  authenticated with `?token=...`; the per-session follow is gated by raw
  retention **and** `query:raw`, exactly like the replay timeline.

Common query params include `since`, `until` (epoch ms), `bins`, `limit`, `scene`,
`session`, `cameraMode`, `source`, and spatial `cellSize` / `region` where supported.

Every aggregate endpoint also accepts `format=full | table | summary` (ADR 0051 §2).
It filters nothing — it picks the result envelope. `full` is the default and returns
the bare rows unchanged (what the dashboard uses); `table` adds a `meta` envelope
(metric, range, applied filters, sample size, row count, `truncated`, limits); and
`summary` returns a bounded digest — ranked top rows, a first/last/min/max/trend
series, or merged spatial clusters, with shares, the metric's caveats and a
templated `reading` sentence — capped at the registry's `maxSummaryRows`, which is
what makes a 500-bin heatmap affordable for an LLM. See
[Result formats](https://uptimizr.com/docs/api/query/#result-formats).

- `GET /health` — liveness probe.

## Security

`@fastify/helmet`, `@fastify/cors` (restricted to `COLLECTOR_CORS_ORIGINS`), and
`@fastify/rate-limit`. Secrets and raw IPs are never logged. The server fails fast
if `VISITOR_HASH_SECRET` is missing.

### Authentication: which endpoints need a key

| Endpoint group                            | Auth               | Why                                                                                                                                                     |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/collect`                    | **None (keyless)** | Runs in untrusted browsers; a key shipped to the client is not a secret. Ingestion is open by design and protected by validation + rate limits instead. |
| Query/read routes                         | `x-api-key`        | Read access is scoped to the project the key resolves to.                                                                                               |
| `POST /api/v1/live/token`                 | `x-api-key`        | Exchanges a project query key for a short-lived SSE token.                                                                                              |
| Live SSE routes (`/api/v1/live/*` `GET`s) | `?token=...`       | Browser `EventSource` cannot attach custom headers, so live streams use short-lived bearer tokens.                                                      |
| `GET /health`                             | None               | Liveness probe.                                                                                                                                         |
| `GET /api/v1/openapi.json`                | None               | API documentation, not data — a client needs it before it has a key. Rate-limited like every other route.                                               |

### API keys and capabilities

A key carries a **set of capabilities** (ADR 0051 §7), not a single role:

| Capability  | Grants                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `query`     | The aggregate analytics API, the scene registry, the live token exchange and `GET /api/v1/audit`.         |
| `query:raw` | Raw per-session streams: `GET /api/v1/sessions/:id/events` and `GET /api/v1/live/sessions/:id`.           |
| `annotate`  | The project **metadata** write path (annotations, glossary, saved analyses, panel specs). Never events.   |
| `ingest`    | Reserved for server-side write paths. Public ingestion is keyless, so issued keys are normally read keys. |

`uptimizr init` / `uptimizr new-project` mint the operator's **owner** key —
`query`, `query:raw` and `annotate`, labelled `owner` — because that key drives the dashboard,
session replay, the live follow and scene regions. `query:raw` is inert on its own: the raw routes
also need `ENABLE_RAW_SESSION_RETENTION`, so granting it up front turns nothing on and only saves
re-minting the key when retention is switched on later.

`uptimizr new-key` is how every **other** key is issued, and it still defaults to `query` alone —
what an agent or MCP client should hold:

```bash
# An agent's own key: read-only aggregates (the default), labelled and budgeted
uptimizr new-key <projectId> --capabilities query --label "mcp-agent" \
  --rate-limit-max 120 --rate-limit-window-ms 60000

# An agent that may also write metadata
uptimizr new-key <projectId> --capabilities query,annotate --label "weekly-report-agent"
```

> **Breaking change.** `query:raw` is new, and the raw per-session endpoints now require **both**
> `ENABLE_RAW_SESSION_RETENTION` **and** `query:raw` — previously retention alone was enough for
> any `query` key. Existing keys keep working for every aggregate endpoint; a key that drives
> session replay or live-follow must be re-minted with `--capabilities query,query:raw`. Keys minted
> by `init` / `new-project` already carry it.

`--rate-limit-max` / `--rate-limit-window-ms` give a key its own request budget, bucketed on the
key id rather than the client IP; keys without one fall back to `COLLECTOR_RATE_LIMIT_*`.
Ingestion keeps its separate `COLLECTOR_INGEST_RATE_LIMIT_*` budget.

### Agent audit log

Every authenticated request made with a key that is not the dashboard's own session is recorded
(`keyId`, `surface`, route pattern, bounded+redacted `params`, `rowCount`, `durationMs`,
`status`), readable at `GET /api/v1/audit` with any `query` key. Refusals are recorded too. A key
never appears in a row — the subject is the key's **id** — and `params` drops credential-shaped
fields and is capped at 512 bytes. Writes happen after the response is flushed, so the audit log
can never block or fail a request. "The dashboard's own session" is a request carrying
`x-uptimizr-client: dashboard` (a volume filter, not a security boundary — set
`AUDIT_DASHBOARD_REQUESTS=1` to record everything). Rows expire after `AUDIT_RETENTION_DAYS`
(default `30`; `0` keeps them forever).

### Threat model for keyless ingestion

Because `POST /api/v1/collect` accepts unauthenticated input, every request is treated as hostile:

- **Validated at the boundary.** Bodies are parsed against [`@uptimizr/schema`](../../packages/schema);
  invalid batches are rejected with `400`. The raw IP is used only to derive the cookieless
  visitor hash and is never stored.
- **Bounded payloads.** The schema caps batch size and every free-text / collection field (see
  the [_Ingestion payload bounds_](../../packages/schema/README.md#ingestion-payload-bounds)
  table). An oversized field rejects the batch, so a single request can't smuggle a huge blob or
  exhaust memory/storage. Connectors truncate locally before sending.
- **Rate limited.** `@fastify/rate-limit` (`COLLECTOR_RATE_LIMIT_MAX` /
  `COLLECTOR_RATE_LIMIT_WINDOW_MS`) caps requests per client.
- **Residual risk.** A keyless endpoint can still receive spoofed or spammy events scoped to a
  known `projectId`. This is an accepted trade-off for cookieless, client-side capture; deployers
  who need stronger guarantees can front the collector with their own auth/WAF and tighten the
  CORS allowlist.

## Configuration

Environment-driven (see [`.env.example`](../../../.env.example)):

- Server / browser access: `COLLECTOR_HOST` (default `0.0.0.0`), `COLLECTOR_PORT`
  (default `4318`), `COLLECTOR_CORS_ORIGINS`, `COLLECTOR_TRUST_PROXY`,
  `COLLECTOR_BODY_LIMIT`.
- Privacy / replay / live: `VISITOR_HASH_SECRET` (required),
  `ENABLE_RAW_SESSION_RETENTION`, `LIVE_TOKEN_SECRET`, `LIVE_TOKEN_TTL_MS`,
  `LIVE_WINDOW_MS`, `LIVE_MAX_CONNECTIONS`, `LIVE_PRESENCE_INTERVAL_MS`.
- Rate limits: `COLLECTOR_RATE_LIMIT_MAX`, `COLLECTOR_RATE_LIMIT_WINDOW_MS`,
  `COLLECTOR_INGEST_RATE_LIMIT_MAX`, `COLLECTOR_INGEST_RATE_LIMIT_WINDOW_MS`
  (a key's own budget overrides the first pair).
- Agent audit: `AUDIT_RETENTION_DAYS` (default `30`, `0` = keep forever),
  `AUDIT_DASHBOARD_REQUESTS` (default off).
- All-in-one dashboard: `COLLECTOR_DASHBOARD_DIR` (optional; see
  [above](#all-in-one-serve-the-dashboard-too)), `COLLECTOR_CSP` (`strict` or `off`).

The storage backend is chosen with `COLLECTOR_STORE`:

- `duckdb` **(default)** — the OSS single-file store (events **and** metadata in one
  DuckDB file at `DUCKDB_PATH`, default `./data/uptimizr.duckdb`). No
  external database service to run. DuckDB is single-writer, so run one collector
  instance per file; back up by copying the file.
- `memory` — a dependency-free in-memory store for local dev / E2E only (seed its
  project/key via `COLLECTOR_MEMORY_PROJECT_ID` / `COLLECTOR_MEMORY_API_KEY`).
- `postgres` — a **single-tenant Postgres store** (`@uptimizr/db-postgres`): events **and**
  metadata in one Postgres database (`POSTGRES_URL` / `DATABASE_URL`, optional `POSTGRES_SCHEMA`,
  `POSTGRES_POOL_MAX`). Multi-writer; identical analytics results (parity suite).
- `mssql` — a **single-tenant Microsoft SQL Server store** (`@uptimizr/db-mssql`): events **and**
  metadata in one SQL Server / Azure SQL database (`MSSQL_URL`, or `MSSQL_SERVER` / `MSSQL_PORT` /
  `MSSQL_DATABASE` / `MSSQL_USER` / `MSSQL_PASSWORD`), created on first boot. Multi-writer;
  identical analytics results (parity suite); SQL Server 2022+ / Azure SQL.
- `clickhouse` — a **single-tenant ClickHouse store** for the scale tier: events **and**
  metadata (projects, API keys, scene representations) live in one ClickHouse database
  (`CLICKHOUSE_URL` / `CLICKHOUSE_DATABASE` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`), created
  on first boot. Use it for concurrent writers / horizontal scale and high-volume ingestion. The
  full analytics surface returns results identical to DuckDB (cross-engine parity suite).

For multi-writer / horizontal scale, choose the `postgres`, `mssql` or `clickhouse` store; spin
up local servers with `infra/docker` (`pnpm stack:up`). The default DuckDB store needs no external
service.

## Develop

```bash
pnpm --filter @uptimizr/collector-server dev    # tsx watch
pnpm --filter @uptimizr/collector-server test   # vitest (inject + fake store)
pnpm --filter @uptimizr/collector-server build
```

The data layer is abstracted by `CollectorStore`, so tests run against a fake store
with `app.inject()` — no live database required. Local end-to-end runs use the
default DuckDB store (a single file, no service to start); the `clickhouse` store in
`infra/docker` backs the optional scale tier.

## License

[Apache-2.0](./LICENSE) © Uptimizr.
