# @uptimizr/react

Embeddable React analytics panels for the [Uptimizr](../../..#readme) collector.
Drop sessions, pointer-heatmap, view-direction-heatmap, and performance panels
straight into your own React app — no separate dashboard required.

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

| Export                                       | Purpose                                                 |
| -------------------------------------------- | ------------------------------------------------------- |
| `UptimizrProvider`                           | Configures `endpoint` + `apiKey` for descendant panels. |
| `useCollectorApi()` / `useUptimizr()`        | Access the shared client / connection in your own code. |
| `SessionsPanel`                              | Most-recent sessions table.                             |
| `PointerHeatmapPanel`                        | 2D pointer heatmap (normalized screen positions).       |
| `ViewDirectionHeatmapPanel`                  | Polar view-direction heatmap (where the camera looked). |
| `PerformanceSummaryPanel`                    | FPS summary (samples, avg / p50 / min).                 |
| `CollectorApi`, response types               | The full typed query client (build custom panels).      |
| `drawPointerHeatmap`, `drawDirectionHeatmap` | The shared canvas painters, for custom renderers.       |

Panels are styled with self-contained inline styles (dark theme) so they render
consistently in any host app. For full custom styling, use `useCollectorApi()`
and render your own UI.

## License

Apache-2.0.
