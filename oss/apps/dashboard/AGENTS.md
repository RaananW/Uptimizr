# AGENTS.md — @uptimizr/dashboard

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The open-source analytics UI for Uptimizr — projects, sessions, heatmaps, performance summaries
and replay for 3D scenes. Built with **Next.js (App Router)** + **Tailwind CSS**.

It is a **passive viewer**. It reads only from the collector's query API
(`@uptimizr/collector-server`) — never ClickHouse/Postgres/DuckDB directly — and it does **no
authoring**: it mints no projects or keys, writes no events, and ships no admin surface. Creating
projects and keys is the `uptimizr` CLI's job; declaring scene regions is the CLI, the
`annotate`-gated HTTP endpoint, or `registerRegions` in `@uptimizr/sdk-core`.

Every panel it renders comes from [`@uptimizr/react`](../../packages/react), which owns the OSS
panel catalog (ADR 0047). The dashboard is a thin consumer that adds chrome, layout and routing.

## Run it

The canonical artifact is a **static export** (`out/`): the same built assets work against any
collector URL, supplied at runtime in the in-UI connection bar, so there is no rebuild per
environment. `DASHBOARD_STATIC=1` is what switches the Next build into `output: "export"` (the
`build:static` and `prepack` scripts set it), and in that mode there is no Next server — the
**static host is responsible for the SPA deep-link fallback**.

```bash
pnpm --filter @uptimizr/dashboard build:static   # emits oss/apps/dashboard/out
```

1. **Standalone server** — zero extra dependencies, serves `out/` on its own port:

   ```bash
   npx -p @uptimizr/dashboard uptimizr-dashboard --port 3000
   ```

2. **All-in-one (collector-served)** — one process for ingestion, query and UI:

   ```bash
   COLLECTOR_DASHBOARD_DIR=./oss/apps/dashboard/out \
     npx -p @uptimizr/collector-server uptimizr serve
   ```

3. **Static drop-in** — copy `out/` to any static host / CDN / object store. Deep links
   (`/projects/:id/...`) need an SPA fallback to `index.html`; the standalone server and the
   collector do that for you.

## Configuration

By default the UI targets the origin it is served from, and the collector URL + API key are set
live in the connection bar. Pre-bake them only for local dev:

| Variable                                    | Purpose                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DASHBOARD_STATIC=1`                        | Build the static export (`output: "export"`, no Next server, no rewrites).                                      |
| `NEXT_PUBLIC_COLLECTOR_URL`                 | Default collector base URL (local dev convenience).                                                             |
| `NEXT_PUBLIC_API_KEY`                       | Default project API key (local dev convenience only — never commit a key).                                      |
| `NEXT_BASE_PATH`                            | Sub-path the export is served under (e.g. `/dashboard`); also exposed to the client as `NEXT_PUBLIC_BASE_PATH`. |
| `NEXT_PUBLIC_PLAYGROUND_URL`                | Playground links (defaults to `http://localhost:5173` locally).                                                 |
| `NEXT_PUBLIC_PANELS_MANIFEST_URL`           | Remote panel manifest to load at runtime (ADR 0041).                                                            |
| `NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS`        | Origins a remote panel module may be loaded from.                                                               |
| `DASHBOARD_PORT` / `PORT`, `DASHBOARD_HOST` | Standalone static server bind settings.                                                                         |

Anything `NEXT_PUBLIC_*` is **baked into the client bundle** and visible to every viewer — never
put a secret there beyond a local-dev key.

## The assistant

`AssistantDrawer` is a collapsed toggle until the user opens it; only then is
`@uptimizr/react/assistant` pulled in via a lazy `import()` (`ssr: false`). That keeps the
assistant and the `@mlc-ai/web-llm` runtime out of the main bundle entirely — a user who never
opens it pays nothing. `app/__tests__/entryPurity.test.ts` guards that seam. The assistant reads
through the **same read-only collector connection** the panels use (ADR 0050), so it works against
a real collector and, unchanged, against the demo's in-browser DuckDB-Wasm layer.

## Rules for agents

- **Query API only.** Never add a direct database client, and never add a server route that
  proxies the collector — the dashboard must stay deployable as plain static files.
- **Panels live in `@uptimizr/react`** (ADR 0047). Add or change a panel there; never fork one
  into this app.
- **Keep it a passive viewer.** No project/key minting, no ingestion, no admin writes. Those are
  the CLI's and the collector's responsibilities.
- **Keep the static export viable.** No feature may require a Next server at runtime: a route that
  must exist in the export is `force-static`, and deep-link routing is handled by the host's SPA
  fallback, not by Next rewrites.
- **Keep the assistant lazily loaded.** A static import of `@uptimizr/react/assistant` (or
  `@mlc-ai/web-llm`) from an app entry is a regression — `entryPurity.test.ts` fails on it.
- The collector URL and key are **runtime** configuration. Do not reintroduce a build-time
  collector URL; one build must work against every environment.
- Privacy (ADR 0003): replay and live-follow read raw per-session data, which needs a collector
  running with `ENABLE_RAW_SESSION_RETENTION` **and** a `query:raw` key. Surface the `403`; never
  work around the gate.
- The dashboard identifies itself with `x-uptimizr-client: dashboard`, which the collector uses as
  an audit **volume filter** (not a security boundary). Do not send that header from an agent.

## Develop

```bash
pnpm --filter @uptimizr/dashboard dev            # http://localhost:3000
pnpm --filter @uptimizr/dashboard build          # Next server build
pnpm --filter @uptimizr/dashboard build:static   # static export (out/)
pnpm --filter @uptimizr/dashboard test
```

## More

- Package reference: [README.md](./README.md)
- Panel package: [`@uptimizr/react`](../../packages/react/AGENTS.md)
- Deploy guide: https://uptimizr.com/docs/deploy/dashboard/
- Query API reference: https://uptimizr.com/docs/api/query/
