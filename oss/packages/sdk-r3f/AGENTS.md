# AGENTS.md — @uptimizr/r3f

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The [react-three-fiber](https://github.com/pmndrs/react-three-fiber) connector for Uptimizr.

R3F renders **three.js**, so this package is a **thin React layer over `@uptimizr/three`** — it
does not re-implement capture, raycasting or coordinate canonicalization. The hook reads the live
`scene` / `camera` / `gl` from the R3F store via `useThree()` and hands them to the three
connector's `trackScene`, then stops capture on unmount.

`react`, `@react-three/fiber` and `three` are **peer dependencies** — the connector reads the host
application's instances and never bundles its own. World-space data is normalized to the canonical
wire frame by `@uptimizr/three`; sessions are attributed to the **`r3f`** connector
(`connector.name === "r3f"`) while keeping three's native right-handed frame (ADR 0018).

## Install

```bash
pnpm add @uptimizr/r3f
# react, @react-three/fiber and three are peer dependencies provided by your app.
```

## Canonical usage

### Declarative component

Drop `<Uptimizr />` anywhere **inside** your `<Canvas>`:

```tsx
import { Canvas } from "@react-three/fiber";
import { Uptimizr } from "@uptimizr/r3f";

<Canvas>
  <Uptimizr projectId="your-project" endpoint="https://collect.example.com" />
  <YourScene />
</Canvas>;
```

### Hook

For access to the `UptimizrClient`, call the hook from a component rendered inside `<Canvas>`:

```tsx
import { useUptimizr } from "@uptimizr/r3f";

function Telemetry() {
  const client = useUptimizr({
    projectId: "your-project",
    endpoint: "https://collect.example.com",
  });
  // client.current?.track("checkout", { sku: "ABC" });
  // client.current?.setScene("level-2");
  return null;
}
```

`useUptimizr` returns an `UptimizrClientRef` (a React ref holding the `@uptimizr/sdk-core`
`UptimizrClient`, or `null` before mount). There is no separate `dispose()` — **unmounting** the
hook/component stops the client, tearing down every DOM listener, timer and rAF callback.

## Options

`UptimizrOptions` **is** the three connector's `TrackSceneOptions`, verbatim — `projectId`,
`endpoint`, `sampling` / `sampleCameraMs` / `samplePerfMs` / `pointerMoveThrottleMs`, the `capture`
toggles (`gaze`, `meshVisibility`, `hoverDwell`, `resourceSample`, …), `actors`, `keyBindings`,
`cameraType`, `xr`, `transport`, `disabled`, `debug`. The R3F layer only adds sourcing
`scene` / `camera` / `gl` from `useThree()`, so those are never passed.

`connector` defaults to `{ name: "r3f" }`; pass `connector` to override the reported `name` or
`version`.

The raycast probe factories (`createSceneRaycaster`, `createGazeRaycaster`, `createXrRaycaster`)
are re-exported here, so an R3F host can build pointer / gaze / WebXR hit-resolution probes — e.g.
`xr: { raycast: createXrRaycaster(scene) }` with `scene` from `useThree()` — without a direct
`@uptimizr/three` dependency.

## Rules for agents

- **Never re-implement capture here.** Anything about what is captured, sampled or normalized is a
  change to `@uptimizr/three`; this package only bridges the R3F store to it.
- Depend only on `@uptimizr/three`, `@uptimizr/sdk-core` and `@uptimizr/schema`.
- Treat `react`, `@react-three/fiber` and `three` as peer dependencies; never bundle them.
- Emit only `@uptimizr/schema` events; do not redefine event shapes.
- Privacy (ADR 0003): no cookies, no persistent client identifier. Attention channels are off by
  default — keep them opt-in. `keyBindings` is an allow-list; `user.id` must be pseudonymous.
- Call the hook/component **inside** `<Canvas>`; outside it there is no R3F store to read.
- `registerRegions(sceneId, regions, { endpoint, apiKey })` (from `@uptimizr/sdk-core`) declares a
  scene's named regions. It **replaces** the scene's set and needs an **`annotate`**-capable key —
  never ship that key in a public bundle; call it from build/deploy/admin code.
- R3F sessions replay through `@uptimizr/replay`'s existing **three** driver — drivers are selected
  by the host's engine, not by connector name, so no R3F-specific driver exists or is needed.

## More

- Package reference: [README.md](./README.md)
- Connector guide: https://uptimizr.com/docs/connectors/r3f/
- three connector guide: [`@uptimizr/three`](../sdk-three/AGENTS.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
