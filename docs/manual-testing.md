# Manual testing guide (Phase 1, OSS)

End-to-end manual verification of the OSS collector: create the single DuckDB store,
ingest events, view them in the dashboard, generate real 3D events from the Babylon
playground, and replay a session. The OSS path needs **no external database service**
(ADR 0020) — events and metadata live in one `.duckdb` file.

> Keep this doc updated when commands, ports, env vars, or scripts change. It is
> the canonical manual-test walkthrough referenced by the `run-local-stack` skill,
> the root README, and `infra/README.md`.

## What you'll verify

- The OSS collector runs against a single DuckDB file (no Docker) and migrations apply.
- The collector ingests batches (`POST /api/v1/collect`, body `{ schemaVersion, events }`) and serves aggregates
  (sessions, pointer/camera heatmaps, top meshes, perf).
- The dashboard renders those aggregates.
- The Babylon playground produces real camera/pointer/mesh/perf events.
- Session replay re-drives a captured session (requires raw retention).

## Prerequisites

- Node 22, pnpm. **No Docker** for the OSS path; Docker is only needed
  for the optional scale tier (ClickHouse + Postgres scale engines).
- OSS ports free: `4318` (collector), `3000` (dashboard), `5173` (playground).
- Scale-tier-only ports: `8123`/`9000` (ClickHouse), `5432` (Postgres), `8080` (Adminer).

## Ports & services at a glance

| Service    | URL                   | Notes                               |
| ---------- | --------------------- | ----------------------------------- |
| Collector  | http://localhost:4318 | Fastify ingestion + query API (OSS) |
| Dashboard  | http://localhost:3000 | Next.js analytics UI (OSS)          |
| Playground | http://localhost:5173 | Babylon demo scene (Vite)           |
| ClickHouse | http://localhost:8123 | Scale-tier event store (HTTP)       |
| Postgres   | localhost:5432        | Scale-tier metadata                 |
| Adminer    | http://localhost:8080 | Scale-tier DB inspection UI         |

> Sections 1–7 cover the OSS collector on a single DuckDB file — no Docker.

## 0. One-time prep

```bash
cd <repo-root>
cp .env.example .env        # local-ready defaults; replay is ON for local testing
pnpm install
pnpm build                  # build all workspace packages once
```

The shipped `.env.example` is tuned for local testing: CORS already allows the
dashboard and playground, a dev `VISITOR_HASH_SECRET` is set, and
`ENABLE_RAW_SESSION_RETENTION=true` so replay works. The project id + API key are
filled in automatically by the seed step (step 2).

> Env loading is automatic — no `source .env` needed. The collector and dashboard
> `dev` scripts self-load the root `.env` via `dotenv`, the playground reads
> `VITE_*` from it via Vite `envDir`, and the `db:*` helper scripts wrap their
> command in `dotenv`. This means `pnpm dev` (start everything via Turborepo) and
> the individual `pnpm dev:*` scripts both pick up `.env` automatically.

## 1. (OSS) No database service to start

The OSS collector uses an embedded **DuckDB** file — there is nothing to spin up.
The file is created by the migrate/seed step below at `DUCKDB_PATH` (default
`./data/uptimizr.duckdb`). DuckDB is **single-writer**: run one collector per file.

> Only the optional scale tier needs Docker (`pnpm stack:up`) for its
> ClickHouse + Postgres scale engines.

## 2. Migrate + seed a project

```bash
pnpm db:setup               # migrate the DuckDB store, then seed the demo projects
```

The seed prints once:

```
✓ project created: <PROJECT_ID> (Demo Project (Viewer))
  API key (store securely, shown once): utk_xxx...
✓ project created: <PROJECT_ID> (Demo Project (Walkable))
  API key (store securely, shown once): utk_yyy...
✓ wrote VITE_PROJECT_ID, VITE_API_KEY, NEXT_PUBLIC_API_KEY, VITE_PROJECT_ID_WALKABLE, VITE_API_KEY_WALKABLE to <repo-root>/.env
✓ recorded 2 project(s) in <repo-root>/.uptimizr/projects.json
```

Two projects are seeded so viewer (arc-rotate) and first-person (walkable) sessions
stay separate (ADR 0026): the playground sends each camera mode to its own project,
and the dashboard's project picker lists both. The seed writes the viewer project
into `VITE_PROJECT_ID` / `VITE_API_KEY` / `NEXT_PUBLIC_API_KEY` and the walkable
project into `VITE_PROJECT_ID_WALKABLE` / `VITE_API_KEY_WALKABLE`, straight into your
root `.env` (it must already exist — that's the `cp .env.example .env` from step 0).
The playground and dashboard pick them up from `.env` on next start; no copying
required. Each key is also printed so you can store it securely.

## 3. Start the collector

New terminal:

```bash
pnpm dev:collector          # http://localhost:4318 (loads .env via dotenv)
```

Smoke-test directly (replace `<PROJECT_ID>` and `utk_...`):

```bash
# health
curl -s http://localhost:4318/health

# ingest one event (projectId MUST match the seeded PROJECT_ID)
curl -s -X POST http://localhost:4318/api/v1/collect \
  -H 'content-type: application/json' \
  -d '{"schemaVersion":"1.0","events":[{"type":"frame_perf","projectId":"<PROJECT_ID>","sessionId":"s-test","ts":'"$(date +%s000)"',"sdkVersion":"0.0.0","fps":60}]}'
# → {"accepted":1,"rejected":0}

# query it back (auth with the API key)
curl -s http://localhost:4318/api/v1/perf -H "x-api-key: utk_..."
# → {"samples":1,"avg_fps":60,...}
```

## 4. Start the dashboard

New terminal:

```bash
pnpm dev:dashboard         # http://localhost:3000 (loads .env via dotenv)
```

Open http://localhost:3000. If `NEXT_PUBLIC_*` weren't picked up, paste the
collector URL (`http://localhost:4318`) and your `utk_...` key into the connection
bar and click **Load**. You should see the perf sample and `s-test` session from
step 3.

## 5. Generate real 3D events with the playground

New terminal (reads `VITE_*` from the root `.env`):

```bash
pnpm dev:playground        # http://localhost:5173
```

Open http://localhost:5173 and **orbit the camera + click the boxes**. Events
flush every ~3s. Reload the dashboard and confirm:

- **Pointer heatmap** lights up where you moved/clicked.
- **View-direction heatmap** fills based on camera angles.
- **Top meshes** lists the boxes you clicked.
- **Sessions** shows your session; **Perf** shows FPS stats.

> **First-person / walkable scenes (ADR 0026)?** Append `?camera=first-person`
> (e.g. http://localhost:5173/?engine=babylon&camera=first-person) — or use the
> panel's camera-mode toggle — to load a walkable room. **Walk with WASD** (Babylon)
> or click-to-lock + WASD (three / PlayCanvas) and click the item pedestals. Then in
> the dashboard set the **Camera mode** filter to _First-person (walk)_ and confirm:
>
> - the **Floor-plan heatmap** lights up where you stood;
> - opening the session shows its **Walked path** (the route you took).

> **Other engines?** The same playground serves three.js, PlayCanvas,
> react-three-fiber, and A-Frame (WebXR) — pick one from the engine selector in the
> top-left panel (the app reloads with `?engine=<id>` and loads only that engine).
> See [`examples/playground/README.md`](../examples/playground/README.md) for the
> per-engine capability matrix.

> **Prefer automation?** The Playwright suite under `examples/playground/e2e`
> reproduces this whole flow headlessly against a throwaway DuckDB store — it
> synthesizes the full event set per WebGL engine, asserts each type lands in the
> DB, and verifies the dashboard renders the captured analytics. Run it with
> `pnpm --filter @uptimizr/example-playground test:e2e` (after `pnpm build`).

## 6. Test session replay

Requires `ENABLE_RAW_SESSION_RETENTION=true` (already set in `.env.example`; if you
changed it, restart the collector after editing `.env`).

Copy the **session id** shown in the playground panel, paste it into the
playground's "Replay a session id" box, and click **Replay session**. The camera
re-drives the recorded path in the same scene. (Replay never emits new analytics
events — ADR 0006.)

## 7. Inspect the store directly (optional)

The OSS store is a single DuckDB file. Inspect it with the DuckDB CLI (use a
read-only connection so you don't take the single writer lock from the collector):

```bash
duckdb -readonly ./data/uptimizr.duckdb \
  "SELECT event_type, count(*) FROM events GROUP BY event_type ORDER BY 2 DESC"
duckdb -readonly ./data/uptimizr.duckdb "SELECT id, name FROM projects"
```

(The optional ClickHouse + Postgres scale stores are inspected via Adminer / the
ClickHouse HTTP interface.)

## 10. Tear down

The OSS path has nothing to stop beyond the dev processes — delete the `.duckdb`
file to reset. For the optional scale engines:

```bash
pnpm stack:down              # stop containers, keep data volumes
# to also drop the data volumes:
docker compose -f infra/docker/docker-compose.yml down -v
```

## Troubleshooting

| Symptom                                         | Cause / fix                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Collector exits immediately on start            | `VISITOR_HASH_SECRET` empty. Use the `pnpm dev:collector` script so `.env` is loaded, and ensure the value is set.    |
| Dashboard/playground gets `401`                 | Missing/wrong `x-api-key`. Use the seeded `utk_...`.                                                                  |
| Dashboard empty but collector has data          | Playground `VITE_PROJECT_ID` doesn't match the project the API key resolves to. They must be the same seeded project. |
| Browser CORS error                              | Add the origin to `COLLECTOR_CORS_ORIGINS` (`:3000` and `:5173` are included by default) and restart the collector.   |
| `GET /api/v1/sessions/:id/events` returns `403` | `ENABLE_RAW_SESSION_RETENTION` is false. Set it true and restart the collector.                                       |
| No rows in the store                            | Confirm `pnpm db:setup` ran and the collector flushed (batch interval ~3s).                                           |
| `IO Error: Could not set lock on file` (DuckDB) | Another process holds the single-writer lock. Stop the other collector/CLI (or use `duckdb -readonly`) and retry.     |
| Next build/prerender crash about `useContext`   | The `build`/`start` scripts pin `NODE_ENV=production`, so this shouldn't recur. If you invoke `next build` directly, prefix it with `NODE_ENV=production`.                              |
| Port already in use                             | Change the port in `.env` / `infra/docker/docker-compose.yml`.                                                        |
