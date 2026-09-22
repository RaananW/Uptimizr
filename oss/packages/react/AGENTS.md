# AGENTS.md — @uptimizr/react

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

Embeddable React analytics panels for an Uptimizr collector, and the **single source of truth for
the OSS dashboard's panel set** (ADR 0047). Drop individual panels into your own React app, render
the entire built-in catalog, or build custom panels on the typed query client. The standalone
`@uptimizr/dashboard` is itself just a thin consumer of this package.

Panels read the collector's **query API** through a shared `CollectorApi` — browser → query API
only, **never the database**. That is the same client the dashboard uses, so there is one
implementation of each panel.

## Install

```bash
pnpm add @uptimizr/react
# react and react-dom are peer dependencies you already have.
```

## Entry points

| Import                      | Contains                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `@uptimizr/react`           | Provider, hooks, `CollectorApi`, the panel contract, the OSS panel catalog and views. |
| `@uptimizr/react/panels-3d` | The Babylon-backed 3D view components (opt-in subpath).                               |
| `@uptimizr/react/assistant` | The in-browser analytics assistant (opt-in, code-split).                              |

## Canonical usage

```tsx
import {
  UptimizrProvider,
  SessionsPanel,
  PointerHeatmapPanel,
  ViewDirectionHeatmapPanel,
  PerformanceSummaryPanel,
} from "@uptimizr/react";

<UptimizrProvider endpoint="http://localhost:4318" apiKey={import.meta.env.VITE_UPTIMIZR_KEY}>
  <PerformanceSummaryPanel />
  <SessionsPanel onSelect={(id) => console.log(id)} />
  <PointerHeatmapPanel params={{ since: Date.now() - 86_400_000, scene: "main" }} />
  <ViewDirectionHeatmapPanel />
</UptimizrProvider>;
```

Every panel accepts an optional `params` object (time range, `scene`, `session`, input `source`, …)
forwarded to the query API. `useCollectorApi()` / `useUptimizr()` hand you the shared client and
connection for custom UI.

### The portable OSS panel catalog (ADR 0036 / 0047)

`ossPanelCatalog` is the complete, portable set of the dashboard's built-in analytics panels. A
host can enumerate and render **every OSS panel from this package alone**, adding only chrome and
layout:

```tsx
import { ossPanelCatalog } from "@uptimizr/react";
import type { PanelContext } from "@uptimizr/react";

for (const panel of ossPanelCatalog) {
  // panel.id / panel.title / panel.span / panel.surfaces describe it;
  // panel.load(ctx) fetches data and panel.render({ data, ctx }) draws the body.
}
```

Each panel is also exported individually (`topMeshesPanel`, `worldHeatmapPanel`, `flowPanel`,
`livePresencePanel`, `sessionReplayPanel`, …) to cherry-pick, and the panel **view** components
(`TopMeshesView`, `FloorPlanHeatmapView`, `PointerHeatmapView`, …) plus the 3D/canvas helper libs
(`mergeSceneProxies`, `disableWheelZoom`, `attachMeshHover`, `buildTwoStageGraph`, …) are exported
for building custom panels.

The world-space 3D heatmap panels (world, gaze, perf, error, boundary) name what a voxel is on when
the selected scene has a registered proxy and named regions (ADR 0051 §2). `voxelHoverLabels(voxels,
cellSize, regions, meshes, extra?)` resolves the region label and the nearest mesh **on the client**,
from the proxy and `api.sceneRegions(sceneId)` the panel already fetched, and feeds
`WorldHeatmap3DView`'s `voxelLabels` — the same rules the collector's summary labelling uses, so a
tooltip and a `format=summary` answer can never disagree. Regions are keyed per scene, so a panel
scoped to "All scenes" gets `[]` and the tooltip falls back to the mesh name alone.
Note the two similarly-named panels. `scene-health` is a raw event-count overview of the selected
window (errors, context loss, attention gaps). `scene-health-score` is the `insight_scene_health`
primitive (ADR 0051 §4): one 0-100 score per scene over six weighted factors, each **normalised
against the project's own preceding window**, read through `CollectorApi.sceneHealth()`. Its bars
are deliberately annotated with the metric id behind each factor (`data-metric`, and the hover
title) — the tile is a routing decision, so a reader has to be able to get from a short bar to the
endpoint that explains it without guessing. A factor whose `score` is `null` could not be measured
and is rendered as an empty bar rather than as a zero; 50 is the project norm, not a pass mark.

### The panel contract (ADR 0036, extended by 0039 and 0041)

Author a panel with `definePanel({ … })` so `load`'s return type flows into `render` and settings
stay typed:

```tsx
import { definePanel, PANEL_CONTRACT_VERSION } from "@uptimizr/react";
import type { PanelDefinition, PanelContext } from "@uptimizr/react";
```

- **Viewer-configurable settings (ADR 0039):** declare `PanelSettingSpec`s (number / boolean /
  select); resolve and persist them with `resolvePanelSettings`, `coercePanelSetting`,
  `pruneDefaultOverrides` and a `PanelStateStore` (`createLocalStoragePanelStore` or
  `memoryPanelStore`).
- **Runtime / remote panels (ADR 0041):** `fetchPanelManifest`, `loadRemotePanels`, `mergePanels`,
  `isPanelDefinition`, `isPanelManifest`, `isContractCompatible` load third-party panels behind the
  **same** `PanelDefinition` interface. `PANEL_CONTRACT_VERSION` bumps only on a breaking contract
  change — check compatibility, never assume it.

### Pinned panel specs (ADR 0051 §7)

A `panelSpecV1` is a panel an agent pinned to the project: a title, a query, a chart name, an
optional encoding, a span and a one-line note. It is **data**, not a module — `specPanel(row)` reads
it and picks a component this package already ships, so there is nothing to `import()` and nothing
to evaluate, and ADR 0041's remote-panel trust decision is not widened.

```tsx
import { loadSpecPanels, mergePanels, ossPanelCatalog } from "@uptimizr/react";

const { panels, errors, rows } = await loadSpecPanels(api);
```

- `specPanel(row)` returns an ordinary ADR 0036 `PanelDefinition` with id `spec:<id>`
  (`SPEC_PANEL_ID_PREFIX`, `specPanelId`, `isSpecPanelId`, `specIdFromPanelId`), the spec's `note`
  as its subtitle and the spec's `span`. It validates against the metric registry inside `load` and
  renders the validator's message inline rather than throwing, because a spec can go stale after it
  was pinned — a metric renamed, a filter withdrawn.
- **`range: "inherit"` is resolved from `ctx.params` on every load**, so a pinned panel follows the
  filter bar like every built-in. A spec may instead pin an explicit `{ since, until }`.
  `specQuery(spec, active)` is that resolution, and asks for `format: "full"`.
- `loadSpecPanels(api)` mirrors ADR 0041's `loadRemotePanels` down to the `RemotePanelError` shape:
  `{ panels, errors, rows }`, one bad spec reported and skipped, nothing thrown. A collector that
  cannot be reached is one `manifest-fetch` error and an empty list.
- `resolveEncoding(spec)` fills every channel the spec left open from the metric's declared
  label/axis/measure columns — the same defaults the assistant's pre-fill uses. `SpecChart` is the
  renderer (`SpecChartProps`, `SpecRow`).
- `CollectorApi` gains `query(queryV1)` — the GET form of `/api/v1/query`, defaulting `format` to
  `full` — plus `panels()`, `pinPanel(spec)`, `updatePanel(id, spec)` and `unpinPanel(id)`, with the
  `PanelSpecRow` type. Reading needs `query`; the three writes need `annotate`.
- `@uptimizr/metrics` is a **direct dependency** of this package for the chart/grain rules. It is
  pure data with no native binding, so the core entry stays browser-safe.

### The in-browser assistant (ADR 0050)

`@uptimizr/react/assistant` ships a drop-in `<AssistantPanel>` and a headless `useAssistant()`
hook. The agent loop runs **entirely in the browser** against the same query API the panels use, and
it **reads only**: every tool call is a `GET`, and no event can be written, altered or deleted
(ADR 0051 §9). It ships **no model and no key**: the user picks a local WebGPU model
(`@mlc-ai/web-llm`, an optional peer, loaded lazily) or a bring-your-own hosted provider.

Two **metadata** actions sit under each answer (ADR 0051 §5): "Annotate this" stores the answer as a
project note, "Save this analysis" stores the turn as a titled record. They appear only when the key
holds the `annotate` capability — the hook asks `GET /api/v1/whoami` once and exposes `canAnnotate`,
`annotate(text, target?)` and `saveAnalysis(title, conclusion)`. Pass
`<AssistantPanel annotationTarget={annotationTargetFor(filters)} />` so a note inherits what the view
is filtered to.

A third action, "Pin as panel" (ADR 0051 §7), keeps the question itself rather than the answer.
`useAssistant()` exposes `pinnableQuery` — the query behind the last answer, or `null` — and
`pinPanel(title, note?)`, which builds a spec with `panelSpecForQuery(query, title, note?)` and
posts it. `panelSpecForQuery` is exported separately, and is pure, so a host can preview what would
be pinned. `<AssistantPanel onPinned={…} />` fires after a successful pin, for a host that reloads
its grid.

```tsx
import { AssistantPanel } from "@uptimizr/react/assistant";

// Reuses an ambient <UptimizrProvider> connection, or takes explicit props:
<AssistantPanel collectorUrl="http://localhost:4318" apiKey="utk_…" />;
```

```tsx
import { useAssistant } from "@uptimizr/react/assistant";

const { messages, send, status, setBackend, backend } = useAssistant({
  collectorUrl: "http://localhost:4318",
  apiKey: "utk_…",
  // Optional: pin the read tools this assistant may call. Omit and the hook chooses —
  // the local (WebGPU) backend gets agent-core's focused core subset, a hosted backend
  // the full ~77-tool catalog. Unknown names are ignored; `[]` falls back to the default.
  tools: ["perf_summary", "jank_rate", "perf_by_device"],
  // systemPrompt, maxSteps, confirmDownload, cachePolicy, persistBackend, now …
});
```

Other `UseAssistantOptions`: `api` (reuse a built `CollectorApi`), `backend` (omit and the hook
loads the persisted choice; with none it stays `null` so the UI can show an explicit first-run
chooser — nothing downloads until the user picks), `systemPrompt` (defaults to
`DEFAULT_SYSTEM_PROMPT`; `composeSystemPrompt` / `refreshSystemPrompt` build and re-stamp it),
`maxSteps` (`DEFAULT_ASSISTANT_MAX_STEPS`, 12), `confirmDownload`, `cachePolicy`
(`"active-only"` default — switching models evicts the previous ~4 GB cache), `onCacheEvicted`,
`persistBackend`, `now`. `<AssistantPanel>` additionally takes `annotationTarget`.

## Rules for agents

- **Query API only.** A panel reads through `CollectorApi`; it never talks to a database and never
  invents an endpoint. A new panel that needs new data means a new metric-registry entry and a
  collector endpoint first.
- **This package is the panel source of truth** (ADR 0047). Add a panel here and the dashboard
  gets it; never fork a panel into `@uptimizr/dashboard`.
- **Keep the core entry Babylon-free and `sideEffects: false`.** The Babylon-backed 3D panels keep
  their view code behind `React.lazy` inside the catalog, so importing `ossPanelCatalog` never
  loads `@babylonjs/*` at module-eval time. `@babylonjs/core`, `@babylonjs/loaders` and
  `@mlc-ai/web-llm` are **optional** peers — a static import of any of them from the core barrel
  is a regression (ADR 0047 / 0050).
- **Keep the assistant and the LLM runtime code-split.** Importing `@uptimizr/react` must pull no
  assistant or LLM code; the assistant itself loads `@mlc-ai/web-llm` lazily, only when a local
  model actually runs.
- **Never ship a key into a public bundle.** The `apiKey` a panel uses is the viewer's; treat it
  as a credential and keep it out of committed source.
- Privacy (ADR 0003): panels render aggregates. Raw per-session views (replay, live-follow) need a
  collector with `ENABLE_RAW_SESSION_RETENTION` **and** a `query:raw` key — surface the `403`, do
  not work around it.
- Catalog panel bodies use the dashboard's Tailwind utility classes. Tailwind v4 skips
  `node_modules`, so a host must add
  `@source "../node_modules/@uptimizr/react/dist/**/*.js";` or the panels render unstyled.

## More

- Package reference: [README.md](./README.md)
- Custom panels guide: https://uptimizr.com/docs/guides/custom-panels/
- Assistant guide: https://uptimizr.com/docs/guides/assistant/
- Query API reference: https://uptimizr.com/docs/api/query/
