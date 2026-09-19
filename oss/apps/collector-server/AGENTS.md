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
#    mint a first project + owner API key, write a local .env.
npx -p @uptimizr/collector-server uptimizr init "My Project"

# 2. Start the ingestion + query API (reads the generated .env; 0.0.0.0:4318).
npx -p @uptimizr/collector-server uptimizr serve
```

`init` prints a **`projectId`** (public — give it to your client SDK along with this server's URL)
and a one-time **API key** (secret — `x-api-key` for the query routes). That key is the operator's
**owner** key: `query`, `query:raw` and `annotate`, labelled `owner`. Do not hand it to an agent —
mint one with `uptimizr new-key <projectId> --capabilities query` instead.

### CLI (ADR 0029)

| Command                        | What it does                                                         |
| ------------------------------ | -------------------------------------------------------------------- |
| `uptimizr init [name]`         | Secret + store + migrations + first project/owner key + `.env`.      |
| `uptimizr serve`               | Run the ingestion + query API. The default when no command is given. |
| `uptimizr new-project <name>`  | Mint an additional project + owner API key.                          |
| `uptimizr new-key <projectId>` | Mint an additional key on an existing project (see the flags below). |
| `uptimizr migrate`             | Apply store migrations.                                              |
| `uptimizr regions set <scene>` | Replace a scene's named regions from `--file <regions.json>`.        |
| `uptimizr regions get <scene>` | Print a scene's named regions as JSON.                               |
| `uptimizr agent report`        | Run a read-only agent once and write a Markdown report (see below).  |
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

### `uptimizr agent report` — headless scheduled reports (ADR 0051 §6)

Runs the headless `runAgent` loop from `@uptimizr/agent-core` **once**, in this process,
over the generated read-only tool catalog against the collector's query API, and writes
Markdown to a file, stdout or a signed webhook. The collector gains no in-process LLM loop;
scheduling is the operator's cron / systemd timer / GitHub Action.

| Flag                 | Meaning                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `--skill <name>`     | Required. `weekly_scene_health`, `attention_hotspots` (needs `--scene`), `xr_comfort_review`.         |
| `--list-skills`      | Print the skills with their descriptions and the metrics each one reads.                              |
| `--scene <id>`       | Scope the report to one scene.                                                                        |
| `--window <NdNhNw>`  | Window back from now (`24h`, `7d` default, `2w`), or `--since` / `--until` in epoch ms.               |
| `--out <file or ->`  | Markdown destination (default `-`, stdout).                                                           |
| `--json <file or ->` | Structured report: tool calls with arguments, durations and outcomes, plus token usage when reported. |
| `--webhook <url>`    | `POST {markdown, report}` to an `http(s)` URL.                                                        |
| `--max-steps <n>`    | Cap on provider turns (default `8`).                                                                  |
| `--dry-run`          | Print the prompt and tool list; call no provider.                                                     |

Environment — read from the environment only and never persisted:
`UPTIMIZR_COLLECTOR_URL`, `UPTIMIZR_API_KEY` (a `query` key is enough; the command only ever
reads), `UPTIMIZR_AGENT_PROVIDER` (`anthropic` default | `openai` | `scripted`),
`UPTIMIZR_AGENT_MODEL`, `UPTIMIZR_AGENT_API_KEY` (falls back to `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY`), `UPTIMIZR_AGENT_ENDPOINT`, `UPTIMIZR_WEBHOOK_SECRET`. The provider key
never reaches a log, a report or an error message.

The system prompt is the shared analytics guidelines plus the rendered `GET /api/v1/context`
document, so a run uses the project's real scene ids and custom-event names; a collector
without that endpoint degrades silently. Webhook bodies carry
`X-Uptimizr-Signature: sha256=<hex HMAC-SHA-256 of the raw body>` and `X-Uptimizr-Delivery`.
Exit codes: `0` ok · `1` usage/config · `2` provider or delivery failure · `3` report
produced but incomplete (a tool call failed, or no answer).

`UPTIMIZR_AGENT_PROVIDER=scripted` is a documented, model-free provider: it calls exactly the
tools the skill names and prints what the collector returned. It is for proving wiring in CI —
it produces data, not analysis.

## API keys and capabilities (ADR 0051 §7)

A key carries a **set of capabilities**, not a single role. `new-key` defaults to `query`;
`init` / `new-project` mint their single key with `query`, `query:raw` and `annotate`.

| Capability  | Unlocks                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`     | The aggregate analytics API, the scene registry, the live token exchange, and `GET /api/v1/audit`.                                                |
| `query:raw` | Raw per-session data: `GET /api/v1/sessions/:id/events`, `GET /api/v1/live/sessions/:id`, and the compacted `GET /api/v1/sessions/:id/narrative`. |
| `annotate`  | The project **metadata** write path (annotations, glossary, saved analyses, panel specs). Never events.                                           |
| `ingest`    | Reserved for server-side write paths. Public ingestion is keyless, so issued keys are normally read keys.                                         |

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
- **`POST /api/v1/query`** (and `GET /api/v1/query?q=<url-encoded JSON>`) — **the query DSL**
  (ADR 0051 §3): one endpoint that runs any registry metric. See below.
- `GET /health` — liveness probe, unauthenticated.

### The query DSL: `POST /api/v1/query` (ADR 0051 §3)

One endpoint for every metric. Name the `metric`, bound it with a `range`, narrow it with the
filters that metric declares, cap it, pick the envelope:

```jsonc
{
  "v": 1,
  "metric": "mesh_sources",
  "range": { "since": 1757000000000, "until": 1757600000000 },
  "filters": { "scene": "lobby", "cameraMode": "first-person" },
  "limit": 20,
  "format": "summary",
}
```

`GET /api/v1/query?q=<url-encoded JSON>` takes the same document (8 KiB cap) for GET-only clients.
Both are reads: same `query` capability, same audit trail, same aggregations.

- The grammar is **closed** — no SQL, no expression language, typed filters, bounded output,
  unknown keys rejected. `range` is required; `format` defaults to `table` here, not `full`.
- A metric, dimension or filter outside the registry's vocabulary is a `400` listing **every**
  objection, each with a stable `code`, the offending `path` and (for a closed list) `accepted`.
  Read `accepted` instead of guessing again.
- `dimensions` may be any subset a metric declares **when** its measure is a portable count —
  event counts, mesh and interaction tallies, input actions, camera gestures. A spatial heatmap or a
  percentile is computed at one fixed grain and refuses anything else, naming the grain it supports.
- **`compare`** — another `{ range }` or `{ segment }`; the result comes back joined on the
  dimension key as `{ current, previous, delta, deltaPct }`, with a significance test where the
  measure is a count and both windows clear the metric's minimum. Never subtract two results by hand.
- **`explain: true`** — the compiled plan instead of the rows: the tier, the SQL with its parameters
  left unbound, `params` by name and type (never value), `rowsScanned`, and `warnings` (a capture
  channel that produced nothing, a sample below the metric's minimum, a truncated result).
- **`drillQuery`** — every row of a `summary` carries the whole query narrowed to that row, ready to
  send straight back.
- `order` takes a measure column, and only where the result is a ranked list.
- `filters.event` (an ADR 0038 step predicate, applied as a **cohort** of sessions) and
  `filters.device` (`os` / `browser` on `session_start`) exist only on the generic tier.

### Result envelopes: `format=full | table | summary` (ADR 0051 §2)

Every aggregate endpoint accepts `format`. It **filters nothing** — it picks the result envelope:

- `full` (default) — the bare rows, unchanged. What the dashboard uses.
- `table` — adds a `meta` envelope: metric, range, applied filters, sample size, row count,
  `truncated`, limits.
- `summary` — a bounded digest: ranked top rows, a first/last/min/max/trend series, or merged
  spatial clusters, with shares, the metric's caveats and a templated `reading` sentence, capped at
  the registry's `maxSummaryRows`. **This is what makes a 500-bin heatmap affordable for an LLM** —
  prefer it over `full` when feeding a model.

### Session narrative: `GET /api/v1/sessions/:id/narrative` (`query:raw`)

The one per-session read worth an agent's time. It compacts the raw stream into an ordered account
of what the session did — scene changes, per-mesh dwell above `minDwellMs`, interactions, frame
dips below `fpsThreshold`, errors, capability changes, XR entry/exit, the end reason — with
timestamps **relative to the session's first event** and a closing `summary` entry of totals.
Bounded by `maxEntries` (default 200, hard cap 1000).

`format` here is `full` | `table` | **`text`**. Prefer `text`: one line per entry, about a third of
the tokens of the JSON, which is what makes a whole session affordable in a context window. There
is no `summary` envelope — a narrative is already one.

Gated **twice**, like the raw stream: `ENABLE_RAW_SESSION_RETENTION` **and** `query:raw`, either
missing is `403`; an unknown session is `404`. It is a projection, never the stream: no
`visitorId`, no URL or page metadata, no positions or rays, no `device` detail beyond the engine,
and custom-event property **keys** only — never their values.

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

### Hosted MCP (`/mcp`, ADR 0051 §7)

`COLLECTOR_MCP_HTTP=1` (off by default) makes the collector serve the **Model Context Protocol**
over MCP's Streamable HTTP transport: `POST /mcp` for JSON-RPC, `GET /mcp` for the server→client
SSE stream, `DELETE /mcp` to end a session. It is the same server `@uptimizr/mcp` runs over stdio —
same tools, resources and prompts, built by the same factory — so a remote agent needs only a URL
and a key, with nothing installed locally.

- Every request is authenticated with `x-api-key` **or** `Authorization: Bearer <key>` (a bearer
  alias accepted on this route only) and needs `query`: `401` without a key, `403` without the
  capability, `403` if a session id is presented by a different key than opened it.
- Tool calls are dispatched to the collector's own query routes **in process**, so they run the
  same validation, scoping and result envelope as the equivalent `curl`, and cost the caller's
  ordinary per-key rate-limit budget once.
- Bounded by `COLLECTOR_MCP_MAX_SESSIONS` (default `50`, one too many → `503`) and
  `COLLECTOR_MCP_SESSION_TTL_MS` (default 30 minutes idle). Audited with `surface: "mcp-http"`.
- Behind a reverse proxy, disable response buffering for `/mcp` (it answers with SSE) and pin a
  session to one instance if you run several.

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

## Conditional subscriptions (ADR 0051 §6)

Standing predicates over a registry metric, delivered over SSE and signed webhooks.

- `GET /api/v1/subscriptions` · `GET /api/v1/subscriptions/:id` ·
  `GET /api/v1/subscriptions/:id/events` — need `query`.
- `POST /api/v1/subscriptions` · `PATCH /api/v1/subscriptions/:id` (`{ enabled }` only) ·
  `DELETE /api/v1/subscriptions/:id` · `POST /api/v1/subscriptions/:id/test[?deliver=true]` —
  need **`annotate`**: creating one is how a caller asks the collector to make an outbound
  request on its behalf.
- `GET /api/v1/subscriptions/stream?token=…` — SSE, live-token auth (ADR 0032 §7), optional
  `&id=` filter, shares `LIVE_MAX_CONNECTIONS`.

Predicates: `threshold` (on the metric's registry headline column only), `anomaly`, `movers`,
`new_value`, `presence`. `evaluate.every` ≥ 1m, `evaluate.window` ≥ 1h. 100 per project, last
100 firings each.

**A webhook secret is write-only** — accepted on create, never returned; reads carry a mask.
**Webhook egress is off until `COLLECTOR_WEBHOOK_ALLOWED_HOSTS` names the hosts**, because a
subscription URL arrives over HTTP and is therefore request-controlled input to an outbound
request. Bodies are signed `X-Uptimizr-Signature: sha256=<hex>` over the raw bytes; verify before
parsing, in constant time.

`POST …/test` is a dry run by default and answers with _why_ it did or did not fire.

## Pinned panels (ADR 0051 §7)

Declarative panels an agent leaves on the project's dashboard. A spec is a title, a query, a chart
name, an optional encoding, a span and a one-line note — **data**, which the dashboard draws with
panel components `@uptimizr/react` already ships. No module is loaded and nothing is evaluated, so
ADR 0041's remote-panel trust decision is not widened.

- `GET /api/v1/panels` (`limit`) — the project's pinned panels, **oldest first**: these are grid
  positions, not a feed. Needs `query`.
- `POST /api/v1/panels` → `201` · `PUT /api/v1/panels/:id` · `DELETE /api/v1/panels/:id` → `204` —
  need **`annotate`**, and are audited like every other metadata write. `PUT` is a full replacement
  (half a spec is not a panel); the row keeps its id, its place in the grid and its original
  authorship. An unknown id — or one belonging to another project, which is deliberately
  indistinguishable — is `404`.
- **Validated twice**, for two different questions: `panelSpecV1Schema` (`@uptimizr/schema`) for the
  shape, then `validatePanelSpec` (`@uptimizr/metrics`) for the vocabulary — does the metric exist
  and accept these filters, does the chart suit its grain, do the encoding columns exist in its
  result. A failure is `400 { error, issues }`, the same body `POST /api/v1/query` answers with, so
  a client fixes the spec from the response instead of guessing. The second check runs at **pin**
  time because a pinned panel is read weeks later: a line chart with no axis to walk along does not
  fail, it draws something a reader takes for a trend.
- `409` when the project already holds `LIMITS.maxProjectPanelSpecs` (50) panels.
- `query.range` may be the literal `"inherit"`, which the dashboard resolves against its filter bar
  on every load, or an explicit `{ since, until }` to pin one period.
- OpenAPI operation ids `list_panels`, `pin_panel`, `update_panel` and `unpin_panel`, under a
  `panels` tag. `CollectorStore` gains `createPanelSpec` / `listPanelSpecs` / `updatePanelSpec` /
  `deletePanelSpec`, implemented by all five stores.

## Other configuration

- Server / browser access: `COLLECTOR_HOST` (`0.0.0.0`), `COLLECTOR_PORT` (`4318`),
  `COLLECTOR_CORS_ORIGINS`, `COLLECTOR_TRUST_PROXY`, `COLLECTOR_BODY_LIMIT`.
- Privacy / replay / live: **`VISITOR_HASH_SECRET` (required — the server fails fast without it)**,
  `ENABLE_RAW_SESSION_RETENTION`, `LIVE_TOKEN_SECRET`, `LIVE_TOKEN_TTL_MS`, `LIVE_WINDOW_MS`,
  `LIVE_MAX_CONNECTIONS`, `LIVE_PRESENCE_INTERVAL_MS`.
- Rate limits: `COLLECTOR_RATE_LIMIT_MAX`, `COLLECTOR_RATE_LIMIT_WINDOW_MS`,
  `COLLECTOR_INGEST_RATE_LIMIT_MAX`, `COLLECTOR_INGEST_RATE_LIMIT_WINDOW_MS`.
- Subscriptions: `COLLECTOR_SUBSCRIPTIONS` (default on; `0` keeps the API and runs no timers),
  `COLLECTOR_SUBSCRIPTIONS_MAX_CONCURRENT` (default `4`),
  **`COLLECTOR_WEBHOOK_ALLOWED_HOSTS`** (empty = no webhook egress at all).
- Agent audit: **`AUDIT_RETENTION_DAYS`** (default `30`; `0` = keep forever),
  `AUDIT_DASHBOARD_REQUESTS` (default off — requests carrying `x-uptimizr-client: dashboard` are
  skipped as a volume filter, **not** a security boundary).
- Hosted MCP: `COLLECTOR_MCP_HTTP` (off by default), `COLLECTOR_MCP_MAX_SESSIONS` (`50`),
  `COLLECTOR_MCP_SESSION_TTL_MS` (`1800000`).
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
