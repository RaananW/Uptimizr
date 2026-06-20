# Design sketch — `demo.uptimizr.com` (backend-less, in-browser demo)

> **Status:** ✅ **Implemented** as [`@uptimizr/demo`](../../oss/apps/demo) (2026-06). This started as
> a mutable pre-phase design note (not an ADR) and the shipped app follows it closely; deviations and
> resolved open questions are recorded in [Implementation notes](#implementation-notes) at the end. It
> composes the **existing** playground and dashboard into a single ephemeral demo that runs the
> analytics store **in the visitor's browser** — no hosted collector, no hosted database, no
> per-visitor cost. The storage-seam and privacy implications were confirmed against
> [ADR 0020](../adr/0020-open-core-storage-boundary.md) and
> [ADR 0003](../adr/0003-privacy-model.md). See [phase plans](./README.md).

## Goal

Ship a public, zero-cost-to-host demo at `demo.uptimizr.com` that:

1. Opens on a **welcome screen** explaining what the visitor is about to see and the demo's limits.
2. Then shows the **playground and dashboard side-by-side**, wired so interacting with the 3D scene
   lights up the dashboard live.
3. **Reuses the existing apps unchanged** — no source edits to the playground or dashboard.
4. Runs the analytics database **entirely in the browser** and **disposes it cleanly** so it never
   burdens the visitor's device.

Non-goals: persistence, multi-visitor/shared state, production-scale data, or representing the
hosted tier's performance. This is a test drive, not a deployment.

## Why this is mostly composition, not new app code

Both apps are already configured by environment, and the dashboard already anticipates embedding the
playground:

- **Playground** ([examples/playground/src/shell.ts](../../examples/playground/src/shell.ts)) POSTs
  batches to a collector at `VITE_COLLECTOR_URL` (`…/api/v1/collect`).
- **Dashboard** ([oss/apps/dashboard/src/lib/api.ts](../../oss/apps/dashboard/src/lib/api.ts)) reads
  from `NEXT_PUBLIC_COLLECTOR_URL` and already defines `DEFAULT_PLAYGROUND_URL` to embed the
  playground for a scene.

So the two apps need only **deploy-time configuration** (collector URL → same origin), not code
changes.

## The architectural consequence of "no hosted DB"

The playground makes a real `fetch()` to ingest; the dashboard makes real `fetch()`es to read. With
no server, something in the browser must answer those HTTP calls. The only way to do that **without
editing either app** is a **Service Worker that emulates the collector HTTP API**, backed by
**DuckDB-Wasm**.

A Service Worker only intercepts requests in **its own origin/scope**. Therefore:

- **No cross-subdomain iframes.** A demo SW at `demo.uptimizr.com` cannot intercept traffic from
  `playground.uptimizr.com` / `dashboard.uptimizr.com`.
- **One origin for everything.** Serve the **built** playground and dashboard assets under
  `demo.uptimizr.com/playground` and `/dashboard`, each built with its collector URL pointed at
  same-origin `/` (`VITE_COLLECTOR_URL=/`, `NEXT_PUBLIC_COLLECTOR_URL=/`). Both iframes are then
  same-origin, so a single SW controls their fetches.

```
demo.uptimizr.com  (one origin)
 ├─ /                     welcome screen + split-view shell (new, tiny)
 ├─ /playground/*         built playground assets  (unchanged app, collector → "/")
 ├─ /dashboard/*          built dashboard assets    (unchanged app, collector → "/")
 ├─ sw.js                 Service Worker: emulates /api/v1/* against the in-browser store
 └─ duckdb worker         SharedWorker owning the single DuckDB-Wasm instance
```

### Emulating the collector surface

The collector exposes one ingest route (`POST /api/v1/collect`) and a **large query surface** —
~25 read endpoints ([oss/apps/collector-server/src/routes/query.ts](../../oss/apps/collector-server/src/routes/query.ts)):
`/api/v1/sessions`, `/api/v1/heatmaps/{pointer,world,gaze,camera,position,click-rays,flow}`,
`/api/v1/meshes/{top,dwell}`, `/api/v1/clicks/{dead,rage}`, `/api/v1/perf/*`, etc. Live SSE routes
(`/api/v1/live/*`) also exist.

**Do not re-implement that SQL in the Service Worker.** `@uptimizr/db` already exposes a
**dialect-agnostic query layer** ([oss/packages/db/src/index.ts](../../oss/packages/db/src/index.ts)):
`buildPointerHeatmap`, `buildWorldHeatmap`, `buildListSessions`, `buildPerfSummary`, … each render a
`QuerySpec` (SQL + params) for a given `Dialect`, and `duckdbDialect` is one of them. The Node store
executes those specs through its native DuckDB client; the browser only needs to execute the **same
specs** against a DuckDB-Wasm client. The right move is:

1. Add a **DuckDB-Wasm store binding** that reuses the existing query builders + `duckdbDialect` +
   event-row mapping (`toEventRow`) and only swaps the **execution** layer (Wasm client instead of
   the native binding). See [the binding spec](#duckdb-wasm-store-binding-spec) below.
2. A **thin SW adapter** maps each `/api/v1/*` route to the matching store method — mirroring what
   the Fastify route handlers already do — and serializes the result as the collector's JSON shape.

This keeps "events live once" and the query SQL in one place; the demo is a third store binding, not
a fork of the query logic.

**Live/SSE routes** (`/api/v1/live/*`) depend on a server push bus. For v1 the demo can disable live
tail (dashboard already degrades when it's unavailable) rather than emulate SSE in the SW.

## DuckDB-Wasm store binding (spec)

A browser-side binding (working name `@uptimizr/db-wasm`, or a browser-safe subpath of
`@uptimizr/db`) that implements the same `CollectorStore` surface the routes depend on
([oss/apps/collector-server/src/store.ts](../../oss/apps/collector-server/src/store.ts)) so the SW
adapter calls it exactly like the real store.

**Reused, unchanged (must be import-safe in the browser — no `node:`/DOM):**

- The query builders (`buildListSessions`, `buildPointerHeatmap`, `buildWorldHeatmap`,
  `buildPerfSummary`, …) and `duckdbDialect` — pure SQL/param construction.
- Event-row mapping `toEventRow` and the row/metadata **types**.
- The DuckDB schema DDL from [duckdb/migrations.ts](../../oss/packages/db/src/duckdb/migrations.ts),
  replayed once into the in-memory Wasm database at startup.

> ✅ **Verified (2026-06):** the reused pieces are import-pure. `events.ts` (→ `toEventRow`) imports
> only `@uptimizr/schema`; `query/dialect.ts`, `query/aggregations.ts`, and `query/duckdbDialect.ts`
> import only `@uptimizr/schema` and each other — **no `node:`/`crypto`/`fs`/`process`/`Buffer`**. The
> *only* Node dependency in the package is `metadata.ts` (`hashApiKey` → `node:crypto`). The catch:
> the package's single `index.ts` barrel re-exports `metadata.ts`, so importing from the **root**
> would drag Node code into the browser bundle. **Action:** add a browser-safe **subpath export**
> (e.g. `@uptimizr/db/query`) that exposes the builders + `duckdbDialect` + `toEventRow` + types
> without the metadata barrel; never import the Node `duckdb/client.ts`.

**New (the only real code):**

- A **DuckDB-Wasm client** that instantiates `AsyncDuckDB` in a Worker and runs a `QuerySpec`
  (`{ sql, params }`) → rows, returning the same row shapes the builders/types describe.
- A `CollectorStore` implementation wiring each method to `builder → duckdbDialect → wasmClient.run`.
- **Auth is stubbed** — the demo has no real keys or projects. `resolveApiKey` returns a fixed demo
  capability; `projectExists` returns `true` for the demo project id. (No PII, nothing to protect.)
- `insertEvents` runs the same enrich/`toEventRow` path, then a parameterized batch `INSERT` — and
  applies the **retention trim** (see Disposal) so memory stays flat.

Net effect: one new execution layer; the SQL, schema, mapping, and types stay single-sourced in
`@uptimizr/db`, preserving the storage seam (ADR 0020) and cross-engine query parity.

## Disposal — never burden the device

This is a first-class requirement, not an afterthought. Three rules:

### 1. Memory-only — no disk footprint (no OPFS)

Run DuckDB-Wasm **in memory only**; do **not** opt into OPFS persistence. Consequences:

- Nothing is written to disk, so there is **nothing to clean up on disk** and no leftover storage.
- Closing the last demo tab terminates the SharedWorker → the WASM heap is freed by the browser
  automatically. "Close the tab" is the primary disposal path.

### 2. Bounded in-session retention (flat memory)

A visitor who plays for many minutes must not accumulate unbounded events. Keep a **rolling window**
(time- or count-based, e.g. last N events / last T minutes); periodically evict older rows so memory
stays flat. This matches the small-scale demo story and prevents slow growth.

> DuckDB-Wasm note: `DELETE` does not immediately release heap. To actually reclaim memory on a hard
> reset, **re-instantiate the DuckDB-Wasm database** (close + re-init) rather than only deleting
> rows. Use eviction for steady-state trimming and re-instantiation for full resets.

### 3. Proactive teardown on explicit signals

Don't wait for GC. Tear down (drop tables / re-instantiate, free buffers) on any of:

- **Last tab disconnects** — the SharedWorker tracks connected ports; when the count hits zero it
  disposes the DB before the browser kills it.
- **Idle timeout** — after X minutes with no interaction, auto-reset and show "demo reset due to
  inactivity," freeing memory for an abandoned-but-open tab.
- **Explicit "Reset demo" button** — instant re-instantiation of the DuckDB-Wasm instance.

### What legitimately persists

Only the **asset cache** the Service Worker keeps for the app/WASM bundles (so reloads are fast).
That is ordinary browser cache — versioned cache name, size-capped, and cleared like any site's
cache. It holds **no visitor data**. (If we want literally zero persistence, the SW can skip caching
at the cost of re-downloading the multi-MB WASM bundle each visit.)

## Prepare demo — one-time asset download

The demo is heavy on first load: the DuckDB-Wasm engine (multi-MB `.wasm` + worker) plus the built
playground and dashboard chunks. Rather than pay that cost invisibly behind the welcome copy, the
welcome screen makes it an explicit, **one-time** step.

**Flow**

1. Welcome screen renders with a primary **“Prepare demo”** button and a one-line explanation:
   *“First time here? We’ll download the demo engine (~N MB) once and cache it on this device — after
   that the demo opens instantly, even offline.”*
2. On click: register the Service Worker, then **precache** the known asset manifest into a
   **versioned Cache Storage** bucket, and **instantiate DuckDB-Wasm once** to warm the WASM compile
   cache and confirm it works.
3. Show **progress** while downloading (a per-asset checklist, or a byte progress bar by reading each
   response’s `Content-Length` / stream). On completion the CTA becomes **“Enter demo”** and advances
   to the split view.
4. **Return visits detect the cache** (assets present + version match) and skip straight to
   **“Enter demo”** — no re-download. If the browser evicted the cache, prepare runs again.

**Ties to disposal:** this precache is *exactly* the one thing the [Disposal](#disposal--never-burden-the-device)
section says legitimately persists — versioned, capped, **no visitor data**. Clearing site data (or a
“Forget demo” link) drops it and returns the visitor to the un-prepared state. Visitor *analytics*
data is never part of this cache; it lives only in memory and is disposed as described above.

**Component draft** (framework-light React; lives in the new demo shell, not in the dashboard/playground):

```tsx
type PrepareState =
  | { phase: "checking" }
  | { phase: "idle" }                              // not prepared yet
  | { phase: "preparing"; done: number; total: number }
  | { phase: "ready" }                             // cached + DuckDB warm
  | { phase: "error"; message: string };

export function WelcomeScreen({ onEnter }: { onEnter: () => void }) {
  const [state, setState] = useState<PrepareState>({ phase: "checking" });

  // On mount, detect a prior preparation (cache present + version match).
  useEffect(() => {
    void isDemoPrepared().then((ready) =>
      setState(ready ? { phase: "ready" } : { phase: "idle" }),
    );
  }, []);

  async function prepare() {
    setState({ phase: "preparing", done: 0, total: DEMO_ASSETS.length });
    try {
      await registerDemoServiceWorker();
      // Precache assets with progress, then warm the WASM engine once.
      await precacheAssets(DEMO_ASSETS, (done, total) =>
        setState({ phase: "preparing", done, total }),
      );
      await warmDuckDbWasm();
      setState({ phase: "ready" });
    } catch (err) {
      setState({ phase: "error", message: String(err) });
    }
  }

  return (
    <section className="demo-welcome">
      <h1>Uptimizr — live in-browser demo</h1>
      <p>
        Interact with the 3D scene on the left and watch the analytics dashboard on the right update
        live. <strong>It all runs on your device</strong> — no account, no server, nothing uploaded.
      </p>

      <DemoLimitations />

      {state.phase === "checking" && <p>Checking your device…</p>}

      {state.phase === "idle" && (
        <button className="cta" onClick={prepare}>
          Prepare demo
          <small>One-time ~{DEMO_DOWNLOAD_MB} MB download · cached locally · works offline after</small>
        </button>
      )}

      {state.phase === "preparing" && (
        <progress value={state.done} max={state.total}>
          Downloading demo engine… {state.done}/{state.total}
        </progress>
      )}

      {state.phase === "ready" && (
        <button className="cta" onClick={onEnter}>Enter demo</button>
      )}

      {state.phase === "error" && (
        <p role="alert">Couldn’t prepare the demo: {state.message}. <button onClick={prepare}>Retry</button></p>
      )}
    </section>
  );
}
```

`isDemoPrepared` / `precacheAssets` / `warmDuckDbWasm` / `registerDemoServiceWorker` are thin helpers
over Cache Storage, `navigator.serviceWorker`, and the DuckDB-Wasm `instantiate` call; `DEMO_ASSETS`
is the static manifest of engine + app chunks to cache.

## What the visitor must understand (welcome-screen copy)

Set expectations before they interact. Group the limits:

- **One-time setup** — the first visit downloads the demo engine (~N MB) and caches it on your
  device so later visits open instantly; clearing site data removes it.
- **Local & temporary** — runs 100% in your browser; nothing is uploaded; **refresh or close wipes
  your data** (the cached engine stays); you can't save, resume, or share your results.
- **Small scale** — the database lives in browser memory (bounded by the WASM address space and your
  RAM); the demo deliberately holds a small volume. Production uses a server-side store that scales
  far beyond this.
- **Illustrative, not production** — server-side aggregation (percentile rollups, retention,
  materialized views, multi-region) isn't running; performance reflects *your device*, and first
  load downloads a multi-MB WASM bundle.
- **Some features off** — anything that exists because there's a server (live presence/SSE,
  API-key auth, durable retry) is simulated or disabled.
- **Modern browser required** — needs WASM + Service Worker/SharedWorker; incognito/locked-down
  browsers may degrade.

Suggested framing turns the constraint into the privacy pitch:

> "This is a **100% in-browser demo**. The analytics database runs *on your device* with
> DuckDB-Wasm — no account, no server, nothing uploaded. Interact with the scene on the left and
> watch the dashboard on the right update live. **It's a sandbox: everything resets when you close
> the tab**, and it runs at a small, local scale. Production uses a scalable server-side store —
> this is the test drive."

A persistent "Demo mode" badge can link to a "How this differs from production" expander so the
first screen stays uncluttered.

## Build cost (honest summary)

| Piece | Effort |
| --- | --- |
| Welcome + split-view shell (new tiny app, one origin) | Low |
| “Prepare demo” precache flow (SW register, asset manifest, progress, warm DuckDB) | Low–Medium |
| Deploy built playground + dashboard under one origin, env → `/` | Low (config) |
| DuckDB-Wasm store binding (reuse query builders + `duckdbDialect`, new Wasm client) | **Medium–High** |
| Service Worker adapter mapping `/api/v1/*` → store methods | Medium |
| Disposal: memory-only, rolling window, teardown triggers, reset UI | Low–Medium |
| Live/SSE: disabled in v1 | None |

The single biggest item is the **DuckDB-Wasm store binding**; everything else is composition,
configuration, and lifecycle wiring.

## Wiring into `pnpm dev:web`

The public-web dev command today is:

```jsonc
// package.json (root)
"dev:web": "turbo run dev --filter=@uptimizr/web --filter=@uptimizr/docs",
```

The new demo app (working name `@uptimizr/demo`) must join it so `pnpm dev:web` brings up the
marketing site, the docs, **and** the demo together:

```jsonc
"dev:web": "turbo run dev --filter=@uptimizr/web --filter=@uptimizr/docs --filter=@uptimizr/demo",
```

The demo's own `dev` script serves the welcome/split-view shell and, in dev, can proxy or co-serve
the built playground/dashboard assets under one origin so the Service Worker + DuckDB-Wasm path is
exercised locally (the same single-origin constraint as production). Pick a fixed dev port that
doesn't collide with `@uptimizr/web` (4321) or `@uptimizr/docs` (4322).

## Open questions

- **Seed vs. empty start:** ship a small pre-seeded session so the dashboard isn't empty on first
  load, or require the visitor to generate data by interacting first?
- **Retention window size:** what N/T keeps the dashboard interesting while staying light on
  low-end/mobile devices?
- **Mobile layout:** true side-by-side needs width; stacked/tabbed fallback on small screens.
- **Iframe embedding headers:** confirm the built apps don't set `X-Frame-Options: DENY` /
  restrictive `frame-ancestors` for the demo origin.
- **Read key in demo:** the static dashboard never inlines a key; the demo would inject a throwaway
  read-only key (or the SW ignores auth entirely since there's no real data to protect).

## Implementation notes

The shipped [`@uptimizr/demo`](../../oss/apps/demo) app follows this sketch with a few concrete
choices. How it actually came together:

### What was built

- **Single-origin shell** — a tiny Vite + React app ([oss/apps/demo](../../oss/apps/demo)). The
  welcome screen ([src/components/WelcomeScreen.tsx](../../oss/apps/demo/src/components/WelcomeScreen.tsx))
  drives the **“Prepare demo”** precache flow; on enter it renders the playground and dashboard
  **side-by-side in same-origin iframes** ([src/components/SplitView.tsx](../../oss/apps/demo/src/components/SplitView.tsx)).
- **Staged embeds, not a proxy** — [scripts/prepare-embeds.mjs](../../oss/apps/demo/scripts/prepare-embeds.mjs)
  builds the playground and dashboard with their collector URLs pointed at same-origin `/` and copies
  the output into `public/playground` and `public/dashboard` (both gitignored). Set `SKIP_EMBEDS=1`
  to reuse already-staged builds during fast iteration.
- **DuckDB-Wasm store, in the page (not a SharedWorker)** — the design proposed a SharedWorker owning
  the DB. The implementation instead keeps the `WasmDb` on the **top page**
  ([src/store/host.ts](../../oss/apps/demo/src/store/host.ts)) because the page outlives the iframes
  and the Service Worker can't hold a long-lived WASM instance. The DuckDB-Wasm worker is still used
  internally by DuckDB; the demo just owns one `AsyncDuckDB` per page.
- **Service Worker as an HTTP→page bridge** — [public/sw.js](../../oss/apps/demo/public/sw.js)
  intercepts `/api/v1/*` and `/health`, forwards them to the controlling page via `MessageChannel`,
  and the page answers from the in-browser store
  ([src/store/collectorStore.ts](../../oss/apps/demo/src/store/collectorStore.ts)). The SW also
  serves a static project registry for `/api/projects` so the dashboard auto-selects the demo project.
- **Reused query layer** — the dispatcher imports the dialect-agnostic builders + `duckdbDialect` +
  `toEventRow` + `DUCKDB_MIGRATIONS` from the browser-safe `@uptimizr/db/query` subpath (added for
  exactly this), so the SQL, schema, and event mapping stay single-sourced in `@uptimizr/db`. The
  only new code is the Wasm execution layer ([src/store/db.ts](../../oss/apps/demo/src/store/db.ts))
  and the Arrow→rows adapter ([src/store/arrow.ts](../../oss/apps/demo/src/store/arrow.ts)).
- **Single-tenant fold** — the demo is single-project, so every collected event is normalized to the
  fixed `DEMO_PROJECT_ID` on ingest, regardless of which project id the embedded playground build was
  configured with. This is what makes the dashboard (which reads `DEMO_PROJECT_ID`) light up.
- **Memory-only + bounded retention** — DuckDB-Wasm runs `:memory:` (no OPFS); `insertEvents` trims
  to `MAX_RETAINED_*` rows so memory stays flat. Closing the tab frees everything.

### Resolved open questions

- **Seed vs. empty start:** empty start. The dashboard fills as the visitor interacts; camera samples
  are captured automatically so it's never blank for long. (Auto-seeding remains a future option.)
- **Read key in demo:** auth is ignored — the SW serves a static demo project/key and the store has
  no real data to protect, consistent with ADR 0003 (no PII).
- **Live presence / SSE:** disabled in v1. The request/response SW bridge can't stream SSE, so the
  dashboard's live tab degrades gracefully (“reconnecting…”, “0 visitors”). This is expected, not a bug.

### Known v1 limitations

- **No SSE live presence** and **minimal replay/scene-representation endpoints** (documented no-ops).
- **Timestamp parity:** DuckDB-Wasm returns `TIMESTAMP` columns as epoch-millisecond numbers; the
  Arrow adapter formats temporal columns to the same **naive-UTC strings** the native DuckDB store
  emits, so the dashboard's `parseTimestamp`/`formatTime` work unchanged.

### Deployment

`demo.uptimizr.com` deploys as its **own Vercel project** pointed at this repo (Vercel's `vercel.json`
is per-project, not multi-project): build with `pnpm --filter @uptimizr/demo build` and serve
`oss/apps/demo/dist`. Run it locally via `pnpm dev:web` (port **4320**) or
`pnpm --filter @uptimizr/demo dev`.
