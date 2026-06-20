# @uptimizr/r3f

The [react-three-fiber](https://github.com/pmndrs/react-three-fiber) (R3F) connector
for Uptimizr.

R3F renders **three.js**, so this package is a **thin React layer over
[`@uptimizr/three`](../sdk-three)** — it does _not_ re-implement capture. The hook
pulls the live `scene`, `camera`, and `gl` (`WebGLRenderer`) out of the R3F store via
`useThree()` and hands them to the three connector, which captures:

- **camera pose** (position + forward direction) → view-direction heatmap
- **pointer move / click** (normalized screen + optional raycast hit) → screen heatmaps
- **mesh picks** → object-engagement analytics
- **FPS** → performance
- **mesh visibility / hover dwell / resource sample** (opt-in) → attention & footprint

`react`, `@react-three/fiber`, and `three` are **peer dependencies**: the connector
reads the host application's instances and never bundles its own. Capture starts when
the hook/component mounts and stops on unmount, tearing down every listener, timer, and
animation-frame callback (no cookies, no persistent ids).

World-space data is normalized to the canonical wire frame by `@uptimizr/three`;
sessions are attributed to the **`r3f`** connector while keeping three's native
right-handed coordinate frame.

## Install

```bash
npm install @uptimizr/r3f @react-three/fiber react three
```

`react`, `@react-three/fiber`, and `three` are **peer dependencies** — the
connector reads your existing instances and never bundles its own.

## Usage

### Declarative component

Drop `<Uptimizr />` anywhere **inside** your `<Canvas>`:

```tsx
import { Canvas } from "@react-three/fiber";
import { Uptimizr } from "@uptimizr/r3f";

function App() {
  return (
    <Canvas>
      <Uptimizr projectId="your-project" endpoint="https://collect.example.com" />
      <YourScene />
    </Canvas>
  );
}
```

### Hook

For access to the `UptimizrClient` (read `sessionId`, emit custom events, stop early),
call the hook from a component rendered inside `<Canvas>`:

```tsx
import { useUptimizr } from "@uptimizr/r3f";

function Telemetry() {
  const client = useUptimizr({
    projectId: "your-project",
    endpoint: "https://collect.example.com",
  });
  // client.current?.track("checkout", { sku: "ABC" });
  return null;
}
```

## Options

The option surface is the three connector's
[`TrackSceneOptions`](../sdk-three/src/trackScene.ts) verbatim — project id, collector
`endpoint`, sampling/fidelity dials (`sampling`), the opt-in `capture` channels
(`meshVisibility`, `hoverDwell`, `resourceSample`), a custom `transport`, `disabled`,
and so on — re-exported as `UptimizrOptions`. The R3F layer only adds sourcing the
`scene` / `camera` / `gl` from `useThree()`, so those are never passed.

The `connector` provenance defaults to `{ name: "r3f" }`; pass `connector` to override
the reported `version` or `name`.

## Replay

R3F sessions replay through the existing
[`@uptimizr/replay`](../replay) **three** driver — the captured payload is three.js
data, only the connector _name_ differs. Replay drivers are selected by the host's
engine, not by connector name, so no R3F-specific driver is needed.

## Boundary

Depends only on `@uptimizr/three`, `@uptimizr/sdk-core`, and `@uptimizr/schema`.
`@uptimizr/three` is the one
connector dependency this package has — by design, since R3F _is_ three.js.

## License

[Apache-2.0](./LICENSE) © Uptimizr.
