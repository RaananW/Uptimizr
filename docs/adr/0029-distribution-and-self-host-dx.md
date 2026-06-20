# ADR 0029: Dashboard distribution and self-host developer experience

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Project owner, engineering
- **Builds on:** [ADR 0004](./0004-monorepo-separation.md) (self-contained OSS monorepo),
  [ADR 0020](./0020-open-core-storage-boundary.md) (DuckDB single-file OSS store),
  [ADR 0005](./0005-backend-framework.md) (thin Fastify backend)

## Context

Uptimizr is consumed through **npm**, not by cloning the monorepo. A 3D developer installs a
connector (e.g. `@uptimizr/babylon`) into their app and self-hosts the collector. Two gaps remain
before that story is smooth:

1. **The dashboard isn't distributable.** `@uptimizr/dashboard` is a `private` Next.js app wired
   for in-repo development (`dotenv -e ../../../.env`, a dev-only `/api/projects` route that reads
   a gitignored file). There is no artifact a user can deploy into their own infrastructure or run
   standalone. Yet the dashboard is, in practice, a **client-rendered SPA**: every analytics call
   in `src/lib/api.ts` runs in the browser against the collector's query API, the collector URL +
   API key are editable live in a connection bar, and the only server route is a local-dev
   convenience that returns `[]` in any real deployment.

2. **Self-hosting is a multi-step manual flow.** Today a user must export `VISITOR_HASH_SECRET`,
   run `npx -p @uptimizr/db uptimizr-db-new-project`, copy the printed id/key, then run
   `npx @uptimizr/collector-server` — and separately figure out how to deploy the UI. That is too
   many moving parts for "get analytics on my scene."

Because the dashboard is client-rendered and the collector is a single self-contained process
(DuckDB, no external services — ADR 0020), several distribution shapes are viable and they are not
mutually exclusive.

## Decision

Adopt a layered distribution + developer-experience model. Each layer is independently useful and
shares one artifact (the dashboard **static export**) and one operational surface (the **`uptimizr`
CLI**).

### A. Dashboard distribution — one artifact, three ways to run it

The dashboard becomes a publishable package that produces a **static export** (`output: "export"`)
as its canonical artifact. The build-time `NEXT_PUBLIC_*` envs are replaced as the source of truth
by a **runtime config** (a small `config.js`/connection-bar value) so the _same_ built assets work
against any collector URL without a rebuild. The dev-only `/api/projects` route is dropped from the
production artifact (it already returns `[]` when deployed).

That single artifact is consumable three ways:

1. **Static integration (user's infrastructure).** Ship the exported assets in the published
   package so a user can serve them from any static host, CDN, object store, or mount them in their
   own app. The collector URL/API key are supplied at runtime (config file or the in-UI connection
   bar).
2. **Collector-served (all-in-one).** The collector optionally serves the dashboard static assets
   at `/`, so a single `uptimizr serve` process exposes ingestion API **+** query API **+** UI **+**
   the DuckDB file — the simplest possible self-host (one command, one process, no external
   service). The collector takes an optional dependency on the dashboard's published static assets.
3. **Standalone server.** A thin static-file server bin (`uptimizr-dashboard`) serves the export on
   its own port for users who want the UI as a separate process from the collector.

### B. `@uptimizr/react` — embeddable components for self-integration

Publish a React component library so developers can embed analytics panels **inside their own React
app** instead of (or alongside) the standalone dashboard. Components are client-only, read the
collector query API through the same `CollectorApi` client the dashboard uses, and are configured
via a provider (`<UptimizrProvider endpoint apiKey>`). The standalone dashboard is refactored to
consume these components, so there is **one** implementation of each panel (sessions list, pointer
heatmap, view-direction heatmap, performance summary), not two. This keeps the OSS boundary intact
(browser → collector query API only; never the database — ADR 0004).

### C. Self-host DX — `create-uptimizr` scaffolder + unified `uptimizr` CLI

- **`uptimizr` CLI (delivered with the collector).** `@uptimizr/collector-server` exposes a single
  `uptimizr` bin with subcommands, superseding the separate `uptimizr-collector` /
  `uptimizr-db-*` bins (kept as aliases for one minor version):
  - `uptimizr init` — generate a strong `VISITOR_HASH_SECRET`, create the DuckDB store, mint a
    first project + API key, and write a local `.env`/config; print the `projectId`, `endpoint`,
    and key once.
  - `uptimizr serve` (default) — run the ingestion + query API, optionally serving the dashboard.
  - `uptimizr new-project "<name>"` — mint additional projects/keys.
  - `uptimizr migrate` — apply store migrations (also run automatically on `serve`/`init`).
- **`create-uptimizr` scaffolder.** `npm create uptimizr@latest` generates a ready-to-run,
  Docker-free self-host folder: a generated secret, a config/`.env`, a tiny runner that calls the
  `uptimizr` CLI, a README, and an optional client snippet for the chosen engine. The scaffolder
  operates the project via the CLI; it does not reimplement collector logic.

## Consequences

### Positive

- One command (`npm create uptimizr` → `uptimizr serve`) stands up API + UI + storage with no
  Docker and no external database.
- A single dashboard artifact and a single set of React panels serve every integration mode
  (static drop-in, all-in-one, standalone, embedded), so there is no duplicated UI logic.
- Runtime-configurable collector URL means the prebuilt UI is reusable across environments without
  rebuilding; matches the existing live connection-bar behaviour.
- Embeddable `@uptimizr/react` lets teams put analytics inside their own product, widening adoption.
- Stays within the self-contained OSS boundary: all UI paths read only the collector query API.

### Negative / trade-offs

- More published surface to version and maintain (`dashboard` assets, `@uptimizr/react`,
  `create-uptimizr`, the unified CLI) and to keep in lockstep at the query-API contract.
- Collector-served UI couples a (optional) dashboard-assets dependency into the collector package
  and grows its install size when that mode is enabled.
- Static export loses Next.js server features (route handlers, server components, image
  optimization). Acceptable because the dashboard is already client-rendered, but it constrains
  future server-side dashboard features.
- Runtime config (vs. `NEXT_PUBLIC_*` baked at build) adds a small bootstrapping step to read the
  collector URL before the app renders.

## Alternatives considered

- **Publish the dashboard as a Next.js `standalone` server only.** Simplest to produce, but forces
  a Node process for a UI that needs none, can't be dropped into a CDN/static host, and doesn't
  enable the all-in-one single-process self-host.
- **Keep the dashboard repo-clone-only.** Contradicts the npm-based distribution model; users would
  clone the monorepo just to get a UI.
- **Scaffolder _or_ CLI (not both).** A scaffolder alone still needs an operational surface to run
  the collector; a CLI alone leaves first-run setup manual. They compose: scaffold once, operate
  with the CLI.
- **Embed panels by iframing the standalone dashboard.** Rejected: poor integration ergonomics,
  styling/isolation issues, and it still duplicates nothing useful versus real React components.

## Rollout

Land incrementally behind this ADR; each step is independently shippable:

1. **(done)** Unified `uptimizr` CLI in `@uptimizr/collector-server`
   (`init` / `serve` / `new-project` / `migrate`), collapsing the multi-step self-host into
   `uptimizr init && uptimizr serve`. Existing `uptimizr-collector` / `uptimizr-db-*` bins remain.
2. **(done)** Dashboard static export (`DASHBOARD_STATIC=1`, emits `out/`) with runtime
   collector-URL config (defaults to the serving origin when none is baked). Consumable three
   ways: the collector serves it all-in-one via `COLLECTOR_DASHBOARD_DIR` (SPA deep-link
   fallback); `@uptimizr/dashboard` is published with the static assets + a zero-dependency
   standalone server bin (`uptimizr-dashboard`); and the same assets drop onto any static host.
3. **(done)** `@uptimizr/react` component library (`<UptimizrProvider>` + self-fetching
   `SessionsPanel` / `PointerHeatmapPanel` / `ViewDirectionHeatmapPanel` /
   `PerformanceSummaryPanel`). The standalone dashboard consumes it: the `CollectorApi` client,
   response types, heat ramp, formatters, and canvas painters live once in the package and the
   dashboard re-exports them.
4. **(done)** `create-uptimizr` scaffolder (`npm create uptimizr@latest`) — generates a
   Docker-free DuckDB self-host folder (secret + `.env`, CLI-wired scripts, README, per-engine
   client snippet); operates the project via the `uptimizr` CLI only.
