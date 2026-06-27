---
title: Custom dashboard panels
description: Write your own dashboard panels with the @uptimizr/react panel contract and register them in the dashboard.
---

The dashboard is built from **panels** — self-contained widgets like the pointer heatmap, the
top-meshes list, or the 3D view-direction dome. Every built-in panel is a plain
`PanelDefinition` object from `@uptimizr/react`, and you can add your own the exact same way
(ADR 0036).

A panel is **declarative**: you describe what data it needs and how to render the body, and the
dashboard host supplies the chrome, the layout slot, the query client, the active filters, and the
live layer. The contract is powerful enough to express every built-in panel — a simple list, a 2D
canvas heatmap, or a full client-only Babylon 3D scene.

## The shape of a panel

```ts
import { definePanel } from "@uptimizr/react";

export const myPanel = definePanel<MyData>({
  id: "my-panel", // stable, unique id
  title: "My panel",
  subtitle: "What it shows", // string, or (ctx) => string
  span: 1, // 1 = half width, 2 = full width
  surfaces: ["overview", "session"], // where it appears; default ["overview"]
  clientOnly: false, // true to skip SSR (canvas / Babylon panels)
  enabled: (ctx) => ctx.capabilities.hasFirstPerson, // optional gate
  load: (ctx) => ctx.api.topMeshes({ ...ctx.params, limit: 25 }),
  render: ({ data, ctx }) => <MyView rows={data} />,
});
```

`definePanel` is an identity helper that keeps the `TData` returned by `load` flowing into
`render`'s `data` argument. `render` returns the panel **body only** — the host wraps it in the
panel card, title, and grid cell.

### Loading data

Give the panel a `load(ctx)` that returns a promise. The host runs it whenever the filters, the
surface, or the inspected session change, cancels superseded requests via an `AbortSignal`
(`ctx.signal`), and tracks `loading` / `error` for you. Panels that self-fetch inside `render`
(e.g. a Babylon scene managing its own requests) simply omit `load`.

Everything you need arrives through the `PanelContext`:

| Field                | What it gives you                                                                     |
| -------------------- | ------------------------------------------------------------------------------------- |
| `api`                | A shared `CollectorApi` bound to the active collector.                                |
| `baseUrl` / `apiKey` | Raw connection details for self-fetch or SSE URLs.                                    |
| `params`             | Query params resolved from the global filter bar (since/until/scene/source…).         |
| `filters`            | Raw filter state, for panels that need `cameraMode` etc. directly.                    |
| `surface`            | `"overview"` or `"session"`.                                                          |
| `sessionId`          | The inspected session id on the session surface.                                      |
| `capabilities`       | Range-derived flags such as `hasFirstPerson`.                                         |
| `actions`            | Host actions: `selectSession`, `setTimeRange`, `setFilters`.                          |
| `live`               | Live layer: `presence`, `enabled`, and `subscribe(handler)` for the SSE firehose.     |
| `settings`           | Resolved values of the panel's declared [`settings`](#per-panel-settings) (ADR 0039). |

### Driving the host from a panel

Use `ctx.actions` to interact with the rest of the dashboard — e.g. open a session drill-down from
a row click, or brush a time range:

```tsx
render: ({ data, ctx }) => (
  <ul>
    {data.map((row) => (
      <li key={row.sessionId}>
        <button onClick={() => ctx.actions.selectSession(row.sessionId)}>{row.label}</button>
      </li>
    ))}
  </ul>
);
```

### Live panels

Panels stay current under realtime traffic (ADR 0032) in two ways.

**Automatic refetch (no code).** On the **overview** surface, an arriving live event throttle-bumps
a host revision, so any panel with a `load()` re-runs and the body repaints. The built-in heatmaps
and lists rely on this — you get live-updating aggregates for free.

**Push subscription (opt-in).** For incremental updates — or to drive a panel from the raw event
firehose — use `ctx.live.subscribe(handler)`. It returns an unsubscribe function, so wire it up
inside an effect in your view component:

```tsx
function PresenceTicker({ ctx }: { ctx: PanelContext }) {
  const [count, setCount] = useState(0);
  useEffect(() => ctx.live.subscribe(() => setCount((c) => c + 1)), [ctx.live]);
  return <span>{count} live events</span>;
}
```

`ctx.live` also exposes `presence` (the current roster snapshot, or `null` when the live layer is
off) and `enabled` (whether a key is set and the layer is connected).

#### Following a live session

The **session** surface is a drill-down snapshot: it does **not** auto-refetch on live events (so an
open inspection isn't reset under the user). If your panel should keep updating while the user
follows an in-progress session, subscribe to the firehose and react to events for that session
yourself — the fan-out fires on the session surface too:

```tsx
function LiveSessionPanel({ ctx }: { ctx: PanelContext }) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  useEffect(() => {
    if (ctx.surface !== "session") return; // only follow on the session drill-down
    return ctx.live.subscribe((event) => {
      if (event.sessionId !== ctx.sessionId) return; // ignore other sessions
      setEvents((prev) => [event, ...prev].slice(0, 50));
    });
  }, [ctx.live, ctx.surface, ctx.sessionId]);

  return <FollowFeed events={events} />;
}
```

Filter on `event.sessionId === ctx.sessionId` so unrelated traffic doesn't churn the followed
session's view. A panel that doesn't subscribe behaves like a frozen snapshot on the session
surface — which is the right default for ended sessions.

## Per-panel settings

A panel can expose its own **typed settings** that a viewer tunes at runtime from the panel's
"⚙" menu (ADR 0039). Declare them with `settings`; the host renders the controls into the chrome,
persists the viewer's choices, and threads the resolved values back through `ctx.settings`.

The primitive set is intentionally small — a clamped `number` (slider), a `boolean` (toggle), and a
`select` (enum):

```ts
export const floorPlanPanel = definePanel({
  id: "floor-plan",
  title: "Floor-plan heatmap",
  clientOnly: true,
  settings: {
    cellSize: {
      type: "number",
      label: "Cell size",
      help: "Ground-plane bin size in world units.",
      default: 1,
      min: 0.25,
      max: 5,
      step: 0.25,
      unit: "m",
    },
  },
  // ctx.settings.cellSize is typed `number`, defaulted + clamped for you.
  load: (ctx) => ctx.api.cameraPositionHeatmap({ ...ctx.params, cellSize: ctx.settings.cellSize }),
  render: ({ data, ctx }) => <FloorPlanView bins={data} cellSize={ctx.settings.cellSize} />,
});
```

`ctx.settings` is the panel's declared defaults overlaid with the viewer's saved overrides, coerced
to valid values (numbers clamped to `[min, max]`, selects validated against `options`). Changing a
setting re-runs `load()` automatically — exactly like a filter change — so the panel re-queries at
the new value. Panels that declare no settings get an empty `ctx.settings` and no "⚙" menu.

Removing or renaming a setting is safe: stored overrides for unknown keys are ignored, and missing
keys fall back to the default, so a viewer's persisted state never breaks an evolving panel.

Several built-in panels ship a data-resolution setting out of the box: the view-direction dome and
pointer heatmap expose a `bins` resolution, the world and gaze↔click heatmaps a voxel `cellSize`,
the flow Sankey a `maxLinks` cap, and top-meshes a Top-N `limit` — each re-queries on change.

## Hiding & restoring panels

Every panel rendered by the host gets a hide ("×") action. Hiding a panel removes it from the grid
and lists it in a **"Hidden panels"** bar, where the viewer can restore it individually or with
"Show all" — so the action is always reversible. Visibility (and settings) persist per surface in
`localStorage` by default; an embedding host can supply its own `PanelStateStore` to back the state
with, say, a user-preferences API. No panel code is needed — this is host chrome that wraps every
`PanelDefinition`.

## Registering a panel

Panels are registered at **build time**. The dashboard exposes a `builtinPanels` array in
`src/panels/registry.tsx`; append your own definitions to it (or to your fork's registry):

```ts
// oss/apps/dashboard/src/panels/registry.tsx
import { myPanel } from "./MyPanel";

export const builtinPanels: PanelDefinition<unknown>[] = [
  topMeshesPanel,
  meshLeaderboardPanel,
  pointerHeatmapPanel,
  cameraDomePanel,
  floorPlanPanel,
  desireLinesPanel,
  meshKindsPanel,
  inputModalityPanel,
  renderScalePanel,
  perfDistributionPanel,
  worldHeatmapPanel,
  navigationMixPanel,
  deadZonePanel,
  flowPanel,
  divergencePanel,
  myPanel, // ← your panel
] as PanelDefinition<unknown>[];
```

The host (`PanelHost`) filters the array by the active surface and each panel's `enabled` gate,
then renders the bodies into the grid. There is nothing else to wire up — no manual placement in
`page.tsx`.

## Loading panels at runtime

Build-time registration is the simplest path, but a self-hoster can also load panels from a
**remote manifest at runtime** — no dashboard rebuild required (ADR 0041). The runtime path uses
the exact same `PanelDefinition` contract; a panel module you can `import()` in the browser is a
panel the dashboard can load.

Runtime loading is **off by default**. Point the dashboard at one or more manifests with a
build-time env var:

```bash
# One manifest, or a comma-separated list.
NEXT_PUBLIC_PANELS_MANIFEST_URL="https://panels.example.com/uptimizr.panels.json"

# Optional allowlist of module origins (comma-separated). When set, only module
# URLs whose origin is listed are imported.
NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS="https://panels.example.com"
```

### The manifest

A manifest is a small JSON document listing the panel modules to load. Each entry declares the
**panel-contract major** it was built against (`contract`), so an incompatible panel is rejected
with a clear error instead of failing in subtle ways:

```json
{
  "version": 1,
  "panels": [
    {
      "id": "co2-budget",
      "url": "https://panels.example.com/co2-budget.js",
      "contract": 1,
      "export": "default"
    }
  ]
}
```

| Field      | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `version`  | Manifest format version (currently `1`).                                     |
| `url`      | Fully-qualified URL of an ES module that exports a `PanelDefinition`.        |
| `contract` | Panel-contract major the module targets; must equal the dashboard's version. |
| `export`   | Named export to read the definition from. Defaults to `default`.             |
| `id`       | Optional label for diagnostics.                                              |

The dashboard exposes its current contract major as `PANEL_CONTRACT_VERSION` from
`@uptimizr/react` — build your panel against it and set `contract` to the same number.

### Building a remote panel module

A remote panel is just a `PanelDefinition` shipped as an ES module. Author it exactly like a
built-in one and export it (here as the default export):

```ts
// co2-budget.ts → bundled to co2-budget.js
import { definePanel } from "@uptimizr/react";

export default definePanel<number>({
  id: "co2-budget",
  title: "Render energy budget",
  load: (ctx) => ctx.api.perfDistribution(ctx.params).then(estimateCo2),
  render: ({ data }) => <Budget grams={data} />,
});
```

Bundle it to a single ES module hosted at the `url` in your manifest. The dashboard imports it in
the browser at runtime and merges it into the grid alongside the built-ins.

### Trust model

:::caution
Remote panels execute **inside the dashboard with full privileges** — the same access to the
React tree, the collector API client, the live SSE layer, and host actions that a built-in panel
has. There is no iframe/worker sandbox (that would break the rich `PanelContext` every panel
relies on). **Only point `NEXT_PUBLIC_PANELS_MANIFEST_URL` at sources you trust**, and prefer
serving panel modules from an origin you control. `NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS` is a
guardrail — it restricts which origins modules may load from — not a sandbox.
:::

### Error handling

Runtime loading never breaks the grid. Each manifest and each panel is loaded independently, and
failures are isolated and surfaced in a dismissible **"panels failed to load"** banner:

- An unreachable or malformed manifest is reported and skipped.
- A panel whose declared `contract` doesn't match the dashboard is rejected as incompatible.
- A module URL outside the configured allowlist is blocked.
- A module that fails to import, is missing its export, or doesn't export a valid
  `PanelDefinition` is reported — the other panels still load.
- A duplicate `id` (clashing with a built-in or another remote panel) is ignored; the existing
  panel wins.
- Even a panel that throws while **rendering** is caught per-panel: it shows an inline error in
  its own card instead of crashing the dashboard.
