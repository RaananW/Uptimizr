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
# 1. One-time setup: generates a visitor-hash secret, creates the DuckDB store,
#    mints a first project + API key, and writes a local .env.
npx -p @uptimizr/collector-server uptimizr init "My Project"

# 2. Start the ingestion + query API (reads the generated .env; 0.0.0.0:4318).
npx -p @uptimizr/collector-server uptimizr serve
```

`init` prints a **`projectId`** and a one-time **API key**. Give the `projectId`
and this server's URL (the **`endpoint`**) to your client SDK (e.g.
`@uptimizr/babylon`); use the **API key** (`x-api-key`) for the query routes /
dashboard. Mint more projects later with
`npx -p @uptimizr/collector-server uptimizr new-project "<name>"`.

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
> the legacy `uptimizr-collector` bin; `@uptimizr/db` exposes
> `uptimizr-db-new-project` / `uptimizr-db-migrate`.

## Endpoints

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
- `GET /api/v1/sessions/:id/events` — ordered replay timeline, **gated by**
  `ENABLE_RAW_SESSION_RETENTION` (returns `403` when disabled); supports buffered
  JSON or NDJSON streaming (`Accept: application/x-ndjson` / `?format=ndjson`).

Live endpoints:

- `POST /api/v1/live/token` — exchange a query API key for a short-lived live token.
- `GET /api/v1/live/presence`, `/live/stream`, `/live/sessions/:id` — SSE streams
  authenticated with `?token=...`; per-session live follow is also gated by raw
  retention.

Common query params include `since`, `until` (epoch ms), `bins`, `limit`, `scene`,
`session`, `cameraMode`, `source`, and spatial `cellSize` / `region` where supported.

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
  `COLLECTOR_INGEST_RATE_LIMIT_MAX`, `COLLECTOR_INGEST_RATE_LIMIT_WINDOW_MS`.
- All-in-one dashboard: `COLLECTOR_DASHBOARD_DIR` (optional; see
  [above](#all-in-one-serve-the-dashboard-too)), `COLLECTOR_CSP` (`strict` or `off`).

The storage backend is chosen with `COLLECTOR_STORE`:

- `duckdb` **(default)** — the OSS single-file store (events **and** metadata in one
  DuckDB file at `DUCKDB_PATH`, default `./data/uptimizr.duckdb`). No
  external database service to run. DuckDB is single-writer, so run one collector
  instance per file; back up by copying the file.
- `memory` — a dependency-free in-memory store for local dev / E2E only (seed its
  project/key via `COLLECTOR_MEMORY_PROJECT_ID` / `COLLECTOR_MEMORY_API_KEY`).
- `clickhouse` — a **single-tenant ClickHouse store** for the scale tier: events **and**
  metadata (projects, API keys, scene representations) live in one ClickHouse database
  (`CLICKHOUSE_URL` / `CLICKHOUSE_DATABASE` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`), created
  on first boot. Use it for concurrent writers / horizontal scale and high-volume ingestion. The
  full analytics surface returns results identical to DuckDB (cross-engine parity suite).

For multi-writer / horizontal scale, choose the `clickhouse` store; spin up a local ClickHouse
with `infra/docker` (`pnpm stack:up`). The default DuckDB store needs no external service.

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
