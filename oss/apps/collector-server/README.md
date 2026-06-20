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

- `POST /api/v1/collect` — accepts a batched `collectRequest`. Validates → enriches
  (server-set cookieless `visitorId = hash(ip + ua + dailySalt)`, raw IP never stored)
  → inserts into the configured `CollectorStore` (DuckDB by default).

### Query (require `x-api-key`)

Aggregations are computed **at query time** (v1) — including the heatmap/perf
aggregates, which run directly in the OSS DuckDB store. Every route is scoped to
the project the API key resolves to.

- `GET /api/v1/sessions`
- `GET /api/v1/heatmaps/pointer`
- `GET /api/v1/heatmaps/camera`
- `GET /api/v1/meshes/top`
- `GET /api/v1/perf`
- `GET /api/v1/sessions/:id/events` — ordered replay timeline, **gated by**
  `ENABLE_RAW_SESSION_RETENTION` (returns `403` when disabled).

Shared query params: `since`, `until` (epoch ms), `bins`, `limit`.

- `GET /health` — liveness probe.

## Security

`@fastify/helmet`, `@fastify/cors` (restricted to `COLLECTOR_CORS_ORIGINS`), and
`@fastify/rate-limit`. Secrets and raw IPs are never logged. The server fails fast
if `VISITOR_HASH_SECRET` is missing.

### Authentication: which endpoints need a key

| Endpoint group                 | Auth               | Why                                                                                                                                                     |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/collect`         | **None (keyless)** | Runs in untrusted browsers; a key shipped to the client is not a secret. Ingestion is open by design and protected by validation + rate limits instead. |
| All query routes (`/api/v1/*`) | `x-api-key`        | Read access is scoped to the project the key resolves to.                                                                                               |
| `GET /health`                  | None               | Liveness probe.                                                                                                                                         |

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

Environment-driven (see [`.env.example`](../../../.env.example)): `COLLECTOR_HOST`,
`COLLECTOR_PORT`, `COLLECTOR_CORS_ORIGINS`, `VISITOR_HASH_SECRET`,
`ENABLE_RAW_SESSION_RETENTION`, `COLLECTOR_DASHBOARD_DIR` (optional; serve a
static dashboard all-in-one — see [above](#all-in-one-serve-the-dashboard-too)).

The storage backend is chosen with `COLLECTOR_STORE`:

- `duckdb` **(default)** — the OSS single-file store (events **and** metadata in one
  DuckDB file at `DUCKDB_PATH`, default `./data/uptimizr.duckdb`). No
  external database service to run. DuckDB is single-writer, so run one collector
  instance per file; back up by copying the file.
- `memory` — a dependency-free in-memory store for local dev / E2E only (seed its
  project/key via `COLLECTOR_MEMORY_PROJECT_ID` / `COLLECTOR_MEMORY_API_KEY`).

The two-store ClickHouse + Postgres path is an optional scale tier and is not required to self-host the OSS collector.

## Develop

```bash
pnpm --filter @uptimizr/collector-server dev    # tsx watch
pnpm --filter @uptimizr/collector-server test   # vitest (inject + fake store)
pnpm --filter @uptimizr/collector-server build
```

The data layer is abstracted by `CollectorStore`, so tests run against a fake store
with `app.inject()` — no live database required. Local end-to-end runs use the
default DuckDB store (a single file, no service to start); the ClickHouse + Postgres
stack in `infra/docker` backs the optional scale tier only.

## License

[Apache-2.0](./LICENSE) © Uptimizr.
