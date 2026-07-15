# @uptimizr/react

Embeddable React analytics panels for the [Uptimizr](../../..#readme) collector,
and the **single source of truth for the OSS dashboard's panel set**. Drop
individual panels into your own React app, or render the entire built-in
catalog — no separate dashboard required.

Panels read the collector's **query API** through a shared client (browser →
query API only; never the database). This is the same `CollectorApi` the
standalone dashboard uses, so there is one implementation of each panel.

## Install

```bash
npm install @uptimizr/react
# peers you already have in a React app:
npm install react react-dom
```

## Use

Wrap your app once, then render any panel:

```tsx
import {
  UptimizrProvider,
  SessionsPanel,
  PointerHeatmapPanel,
  ViewDirectionHeatmapPanel,
  PerformanceSummaryPanel,
} from "@uptimizr/react";

export function Analytics() {
  return (
    <UptimizrProvider endpoint="http://localhost:4318" apiKey={import.meta.env.VITE_UPTIMIZR_KEY}>
      <PerformanceSummaryPanel />
      <SessionsPanel onSelect={(id) => console.log(id)} />
      <PointerHeatmapPanel />
      <ViewDirectionHeatmapPanel />
    </UptimizrProvider>
  );
}
```

Every panel accepts an optional `params` object (time range, `scene`, `session`,
input `source`, …) forwarded to the query API:

```tsx
<PointerHeatmapPanel params={{ since: Date.now() - 86_400_000, scene: "main" }} />
```

## What's exported

| Export                                       | Purpose                                                   |
| -------------------------------------------- | --------------------------------------------------------- |
| `UptimizrProvider`                           | Configures `endpoint` + `apiKey` for descendant panels.   |
| `useCollectorApi()` / `useUptimizr()`        | Access the shared client / connection in your own code.   |
| `SessionsPanel`                              | Most-recent sessions table.                               |
| `PointerHeatmapPanel`                        | 2D pointer heatmap (normalized screen positions).         |
| `ViewDirectionHeatmapPanel`                  | Polar view-direction heatmap (where the camera looked).   |
| `PerformanceSummaryPanel`                    | FPS summary (samples, avg / p50 / min).                   |
| `CollectorApi`, response types               | The full typed query client (build custom panels).        |
| `drawPointerHeatmap`, `drawDirectionHeatmap` | The shared canvas painters, for custom renderers.         |
| `ossPanelCatalog`                            | The complete, portable OSS panel catalog (ADR 0047).      |
| `topMeshesPanel`, `worldHeatmapPanel`, …     | Each catalog panel, exported individually to cherry-pick. |
| `livePresencePanel`, `sessionReplayPanel`    | Live-now roster and session replay panels (ADR 0049).     |
| `LivePresenceView`, `useLiveSession`         | Live presence body + per-session live-follow hook.        |
| `TopMeshesView`, `FloorPlanHeatmapView`, …   | Panel body components (host supplies the chrome).         |
| `mergeSceneProxies`, `attachMeshHover`, …    | 3D/canvas helper libs shared by the panels.               |
| `@uptimizr/react/panels-3d`                  | Babylon-backed 3D view components (opt-in subpath).       |
| `@uptimizr/react/assistant`                  | In-browser analytics assistant (opt-in, code-split).      |

Panels are styled with self-contained inline styles (dark theme) so they render
consistently in any host app. For full custom styling, use `useCollectorApi()`
and render your own UI.

## The portable OSS panel catalog

`ossPanelCatalog` is the complete, portable set of the dashboard's built-in
analytics panels (ADR 0036 / ADR 0047). A host can enumerate and render **every
OSS panel from this package alone** — it adds only chrome and layout. The
standalone dashboard is itself just a thin consumer of this array.

```tsx
import { UptimizrProvider, ossPanelCatalog } from "@uptimizr/react";
import type { PanelContext } from "@uptimizr/react";

// Render the whole catalog with your own host chrome:
for (const panel of ossPanelCatalog) {
  // panel.id / panel.title / panel.span / panel.surfaces describe it;
  // panel.load(ctx) fetches data and panel.render({ data, ctx }) draws the body.
}
```

Each panel is also exported individually (`topMeshesPanel`, `worldHeatmapPanel`,
`flowPanel`, …) so you can cherry-pick, and the panel **view** components
(`TopMeshesView`, `FloorPlanHeatmapView`, `PointerHeatmapView`, …) plus their 3D
helper libs (`mergeSceneProxies`, `disableWheelZoom`, `attachMeshHover`,
`buildTwoStageGraph`, …) are exported for building custom panels.

### Babylon.js is an optional, code-split peer

The core entry has **no runtime dependency on Babylon** and stays
`sideEffects: false` (tree-shakeable). The Babylon-backed 3D panels
(`camera-dome-3d`, `world-heatmap-3d`, `perf-heatmap-3d`,
`error-heatmap-3d`, `flow-sankey-3d`, `gaze-click-divergence-3d`,
`session-replay`) keep their view code behind `React.lazy` inside the catalog,
so importing `ossPanelCatalog` never loads `@babylonjs/*` at module-eval time —
Babylon chunks are fetched only when a 3D panel actually renders.
`@babylonjs/core` and `@babylonjs/loaders` are declared as **optional** peers;
add them to your app only if you render a 3D panel that needs them.

To compose a 3D view **directly** (outside the catalog), import the dedicated
subpath — this is the only entry that pulls the 3D view modules into your graph:

```tsx
import { WorldHeatmap3DView, ClickRays3DView, SessionReplayView } from "@uptimizr/react/panels-3d";
```

Pair it with your bundler's lazy loading (`React.lazy` / `next/dynamic`) to keep
Babylon out of your initial bundle.

### Styling the catalog panels (Tailwind)

The catalog's panel bodies use the dashboard's Tailwind utility classes
(`bg-panel`, `text-fg-muted`, `border-edge`, …). Tailwind v4 auto-detects
content but **skips `node_modules`**, so a host that renders these panels must
point Tailwind at this package's source, otherwise the classes are tree-shaken
out of the generated stylesheet and the panels render unstyled:

```css
/* your globals.css */
@import "tailwindcss";
@source "../node_modules/@uptimizr/react/dist/**/*.js";
```

## In-browser analytics assistant (opt-in)

The `@uptimizr/react/assistant` subpath ships a drop-in `<AssistantPanel>` and a
headless `useAssistant()` hook that let anyone ask natural-language questions of
their 3D analytics — the agent loop runs **entirely in the browser** against the
same read-only query API the panels use (ADR 0050). It ships **no model and no
key**: the user picks a local WebGPU model or a bring-your-own hosted provider.

```tsx
import { AssistantPanel } from "@uptimizr/react/assistant";

// Reuses an ambient <UptimizrProvider> connection, or take explicit props:
<AssistantPanel collectorUrl="http://localhost:4318" apiKey="proj_…" />;
```

Or drive it yourself with the hook:

```tsx
import { useAssistant } from "@uptimizr/react/assistant";

const { messages, send, status, setBackend, backend } = useAssistant({
  collectorUrl: "http://localhost:4318",
  apiKey: "proj_…",
});
```

Like `panels-3d`, the LLM runtime is **optional and code-split**: importing the
core `@uptimizr/react` barrel pulls **no** assistant or LLM code, and even the
assistant loads `@mlc-ai/web-llm` (an optional peer) lazily, only when a local
model actually runs. See the [assistant guide](https://uptimizr.com/docs/guides/assistant/).

## License

Apache-2.0.
