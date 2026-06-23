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

| Field                | What it gives you                                                                 |
| -------------------- | --------------------------------------------------------------------------------- |
| `api`                | A shared `CollectorApi` bound to the active collector.                            |
| `baseUrl` / `apiKey` | Raw connection details for self-fetch or SSE URLs.                                |
| `params`             | Query params resolved from the global filter bar (since/until/scene/source…).     |
| `filters`            | Raw filter state, for panels that need `cameraMode` etc. directly.                |
| `surface`            | `"overview"` or `"session"`.                                                      |
| `sessionId`          | The inspected session id on the session surface.                                  |
| `capabilities`       | Range-derived flags such as `hasFirstPerson`.                                     |
| `actions`            | Host actions: `selectSession`, `setTimeRange`, `setFilters`.                      |
| `live`               | Live layer: `presence`, `enabled`, and `subscribe(handler)` for the SSE firehose. |

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

## Registering a panel

Panels are registered at **build time**. The dashboard exposes a `builtinPanels` array in
`src/panels/registry.tsx`; append your own definitions to it (or to your fork's registry):

```ts
// oss/apps/dashboard/src/panels/registry.tsx
import { myPanel } from "./MyPanel";

export const builtinPanels: PanelDefinition<unknown>[] = [
  topMeshesPanel,
  pointerHeatmapPanel,
  cameraDomePanel,
  floorPlanPanel,
  myPanel, // ← your panel
] as PanelDefinition<unknown>[];
```

The host (`PanelHost`) filters the array by the active surface and each panel's `enabled` gate,
then renders the bodies into the grid. There is nothing else to wire up — no manual placement in
`page.tsx`.

:::note
Panels are registered at build time today. Loading panels from a remote URL or a plugin manifest at
runtime is tracked for a future release; the contract is designed so that path can be added without
changing existing panels.
:::
