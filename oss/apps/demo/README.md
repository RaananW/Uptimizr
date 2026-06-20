# @uptimizr/demo — backend-less, in-browser demo

A fully **in-browser** demo of Uptimizr that powers `demo.uptimizr.com`. The playground feeds an
analytics store running **in the visitor's browser** (DuckDB-Wasm), and the dashboard reads from it
through a Service-Worker collector shim. **No hosted database, no server, nothing leaves the
browser.**

It reuses the existing playground and dashboard apps **unchanged** — this package is just the shell
that composes them and supplies the in-browser store.

See the full design and rationale in
[docs/phases/demo-in-browser-design.md](../../../docs/phases/demo-in-browser-design.md).

## How it works

```
demo.uptimizr.com  (one origin)
 ├─ /                  welcome screen + side-by-side split view  (this app)
 ├─ /playground/*      staged playground build (collector URL → "/")
 ├─ /dashboard/*       staged dashboard build   (collector URL → "/")
 ├─ sw.js              Service Worker: intercepts /api/v1/* and bridges to the page
 └─ DuckDB-Wasm        in-memory analytics store, owned by the top page
```

1. **Welcome screen** ([src/components/WelcomeScreen.tsx](src/components/WelcomeScreen.tsx)) runs a
   one-time **“Prepare demo”** precache (Service Worker + DuckDB-Wasm warm-up), cached locally so
   later visits open instantly and offline.
2. **Split view** ([src/components/SplitView.tsx](src/components/SplitView.tsx)) embeds the
   playground and dashboard as same-origin iframes; interacting with the 3D scene lights up the
   dashboard live.
3. The **Service Worker** ([public/sw.js](public/sw.js)) intercepts the collector HTTP API and
   forwards each request to the controlling page via `MessageChannel`.
4. The **page-hosted store** ([src/store/host.ts](src/store/host.ts) →
   [src/store/collectorStore.ts](src/store/collectorStore.ts)) answers those requests by running the
   **same dialect-agnostic query builders** as the real collector (imported from the browser-safe
   `@uptimizr/db/query` subpath) against an in-memory DuckDB-Wasm database
   ([src/store/db.ts](src/store/db.ts)).

The only demo-specific logic is the Wasm execution layer, the Arrow→rows adapter
([src/store/arrow.ts](src/store/arrow.ts)), and a single-tenant fold that normalizes every collected
event to the fixed demo project so the dashboard sees it. The SQL, schema, and event mapping stay
single-sourced in `@uptimizr/db` (preserving the storage seam — ADR 0020).

## Run locally

```bash
# As part of the public-web dev stack (web + docs + demo):
pnpm dev:web                     # demo on http://localhost:4320

# Or just the demo:
pnpm --filter @uptimizr/demo dev

# Skip the (heavy) embed rebuild and reuse already-staged builds:
SKIP_EMBEDS=1 pnpm --filter @uptimizr/demo dev
```

## Scripts

| Script           | What it does                                                              |
| ---------------- | ------------------------------------------------------------------------ |
| `dev`            | Vite dev server (port 4320); `predev` stages the embeds first            |
| `build`          | `prebuild` stages embeds, then Vite production build → `dist/`           |
| `prepare-embeds` | Builds the playground + dashboard with collector URL `/` into `public/`  |
| `typecheck`      | `tsc --noEmit`                                                           |
| `lint`           | ESLint                                                                    |
| `test`           | Vitest unit tests                                                         |
| `clean`          | Remove `dist/` and the staged embeds                                      |

`SKIP_EMBEDS=1` makes `predev`/`prebuild` reuse already-staged embeds (or placeholders) instead of
rebuilding them — much faster for iterating on the shell or store.

## Privacy & disposal

- **Memory-only** — DuckDB-Wasm runs `:memory:` (no OPFS); nothing is written to disk.
- **Bounded retention** — ingestion trims to a rolling window so memory stays flat.
- **Closing the tab frees everything.** The only thing that persists is the versioned asset cache
  (app + WASM bundles) — it holds **no visitor data** and is cleared like any site cache.
- No accounts, no API keys, no PII. Consistent with [ADR 0003](../../../docs/adr/0003-privacy-model.md).

## Known v1 limitations

- **No live presence / SSE** — the request/response Service-Worker bridge can't stream SSE, so the
  dashboard's live tab degrades gracefully (“reconnecting…”, “0 visitors”). Expected, not a bug.
- **Minimal replay / scene-representation** endpoints (documented no-ops).
- Dashboard sections that need manual 3D interaction (mesh/pointer/first-person/resources) stay empty
  until the visitor interacts.

## Deployment

`demo.uptimizr.com` is its **own Vercel project** pointed at this repo (Vercel's `vercel.json` is
per-project, not multi-project — you don't put two output dirs in one file). Configure it to build
with `pnpm --filter @uptimizr/demo build` and serve `oss/apps/demo/dist`.
