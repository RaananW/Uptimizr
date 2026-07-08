# @uptimizr/dashboard

The open-source analytics UI for Uptimizr — projects, sessions, heatmaps, and
performance summaries for 3D scenes. Built with **Next.js (App Router)** +
**Tailwind CSS**.

The dashboard reads only from the collector's **query API**
(`@uptimizr/collector-server`); it never talks to ClickHouse/Postgres directly
and stays within the OSS boundary.

## Run it (three ways)

The dashboard's canonical artifact is a **static export** (`out/`) — the same
built assets work against any collector URL, supplied at runtime in the in-UI
connection bar (no rebuild per environment).

```bash
# Produce the static export once.
pnpm --filter @uptimizr/dashboard build:static   # emits oss/apps/dashboard/out
```

1. **Standalone server** — serve the export on its own port (zero extra deps):

   ```bash
   npx -p @uptimizr/dashboard uptimizr-dashboard --port 3000   # or PORT / DASHBOARD_PORT
   ```

2. **All-in-one (collector-served)** — one process for ingestion, query, and UI.
   Point the collector at the export and start it:

   ```bash
   COLLECTOR_DASHBOARD_DIR=./oss/apps/dashboard/out \
     npx -p @uptimizr/collector-server uptimizr serve
   ```

3. **Static drop-in** — copy `out/` to any static host / CDN / object store, or
   mount it in your own app. Deep links (`/projects/:id/...`) need an SPA
   fallback to `index.html` (the standalone server and collector do this for you).

## Configure

By default the UI targets the origin it is served from; override the collector
URL and API key live in the connection bar. For local dev you can pre-bake them:

```bash
# oss/apps/dashboard/.env.local
NEXT_PUBLIC_COLLECTOR_URL=http://localhost:4318
NEXT_PUBLIC_API_KEY=utk_...        # optional convenience for local dev
```

Other optional knobs:

- Standalone static server: `DASHBOARD_PORT` / `PORT` and `DASHBOARD_HOST`.
- Static export sub-path: `NEXT_BASE_PATH` (for embedded builds such as `/dashboard`).
- Playground links: `NEXT_PUBLIC_PLAYGROUND_URL` (defaults to `http://localhost:5173` locally).
- Runtime panels: `NEXT_PUBLIC_PANELS_MANIFEST_URL` and
  `NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS`.

## Develop

```bash
pnpm --filter @uptimizr/dashboard dev     # http://localhost:3000
```

## Build

```bash
pnpm --filter @uptimizr/dashboard build          # Next server build
pnpm --filter @uptimizr/dashboard build:static   # static export (out/)
```

> Note: the `build`/`build:static`/`start` scripts pin `NODE_ENV=production` inline, so a stray
> exported `NODE_ENV=development` in your shell no longer crashes the prerender step. You don't
> need to `unset NODE_ENV` manually.

## Current OSS surface

- Project/session selection, live presence, and live event feed.
- Registry-driven panels from `@uptimizr/react`: sessions, pointer/world/view-direction heatmaps,
  mesh and interaction leaderboards, funnels, paths, performance, diagnostics, XR summaries, and
  more.
- Session detail with metadata/raw-event inspector, replay view, live-follow replay when the
  session is active, and first-person trajectory view.
- Optional runtime/remote panels via `NEXT_PUBLIC_PANELS_MANIFEST_URL`.
