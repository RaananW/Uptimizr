---
title: Analytics for React Three Fiber apps
description: Add object click tracking, view-direction heatmaps, real-user FPS and custom events to a React Three Fiber app with one component, including consent and Next.js setup.
lastUpdated: 2026-11-27
---

To add analytics to a React Three Fiber (R3F) app, put one component inside your `<Canvas>`.
[`@uptimizr/r3f`](/docs/connectors/r3f/) reads the scene, camera and renderer from the R3F store
and hands them to the [three.js connector](/docs/connectors/three/). It then captures clicks on
meshes, camera direction, movement and frame rate, and sends them to a collector you run yourself.

Product analytics tools see your R3F app as one `<canvas>` element. This guide covers what they
miss and how to capture it.

## Install

```bash
npm install @uptimizr/r3f @react-three/fiber react three
```

`react`, `@react-three/fiber` and `three` are peer dependencies, so the connector uses the copies
your app already has. You also need a collector. Run `npm create uptimizr@latest` to scaffold one,
or see [Run the collector](/docs/deploy/collector/).

## Add the component

```tsx
import { Canvas } from "@react-three/fiber";
import { Uptimizr } from "@uptimizr/r3f";

export function App() {
  return (
    <Canvas>
      <Uptimizr projectId="my-r3f-app" endpoint="https://collect.example.com" />
      <Product />
    </Canvas>
  );
}
```

The component has to be **inside** `<Canvas>`, because that's where the R3F store lives. Capture
starts when it mounts and stops when it unmounts, which removes every listener, timer and
animation-frame callback.

## What you get

Out of the box, without further setup:

- **Object clicks.** Each click or tap that hits a mesh is logged with the mesh name and the
  world-space hit point. Drags from `OrbitControls` count as camera gestures, not clicks.
- **Missed clicks.** Clicks that hit nothing, and rapid repeat clicks on one mesh.
- **View direction.** Where the camera pointed, as a heatmap on a sphere.
- **Movement.** Camera positions, for a floor-plan heatmap in walkable scenes.
- **Performance.** FPS samples from real visitors' devices.
- **WebXR.** Controller, hand and gaze input, once a session goes immersive.

Opt-in signals, such as gaze on geometry, hover dwell and on-screen time per mesh, use the same
`capture` option as the three.js connector:

```tsx
<Uptimizr
  projectId="my-r3f-app"
  endpoint="https://collect.example.com"
  capture={{ gaze: true, hoverDwell: true, meshVisibility: true }}
/>
```

## Name your meshes

Reports use the name of the mesh a ray hit, so name the meshes you care about. In JSX that's the
`name` prop:

```tsx
<mesh name="product-hero" onClick={select}>
  <boxGeometry />
  <meshStandardMaterial />
</mesh>
```

For a loaded model, set names on the nodes from `useGLTF`, or in your modelling tool before export.
Auto-generated names such as `Cube012` and clone suffixes such as `Box.001` make the rankings hard
to read.

## Track your own events

Use the `useUptimizr()` hook when you need the client, for example to send custom events. Call it
in a component rendered inside `<Canvas>`. It returns a ref whose `current` is the client, and is
`null` until capture starts:

```tsx
import { useUptimizr } from "@uptimizr/r3f";

function Product() {
  const client = useUptimizr({ projectId: "my-r3f-app", endpoint: "https://collect.example.com" });

  return (
    <mesh
      name="add-to-cart"
      onClick={() => client.current?.track("add_to_cart", { sku: "CHAIR-01" })}
    >
      <boxGeometry />
      <meshStandardMaterial />
    </mesh>
  );
}
```

Use either the component or the hook, not both, or you'll start two sessions.

Use `client.current?.setScene("checkout")` when the app moves to a different area or view, so
reports can be filtered by scene.

## Consent

`disabled` is reactive, so it works as a consent switch. Capture starts when it changes from `true`
to `false`, and stops when it changes back:

```tsx
const [consented, setConsented] = useState(false);

<Canvas>
  <Uptimizr projectId="my-r3f-app" endpoint="https://collect.example.com" disabled={!consented} />
</Canvas>;
```

The default setup writes no cookies and stores no persistent identifier in the browser, which you
can confirm in the [privacy model](/docs/deploy/privacy/). Whether you still need a consent banner
depends on your jurisdiction and what you capture.

## Next.js

R3F only renders in the browser, so the file that holds your `<Canvas>` is already a client
component. Put `<Uptimizr />` in that same file:

```tsx
"use client";

import { Canvas } from "@react-three/fiber";
import { Uptimizr } from "@uptimizr/r3f";

export default function Scene() {
  return (
    <Canvas>
      <Uptimizr
        projectId={process.env.NEXT_PUBLIC_UPTIMIZR_PROJECT!}
        endpoint={process.env.NEXT_PUBLIC_UPTIMIZR_ENDPOINT!}
      />
      {/* ... */}
    </Canvas>
  );
}
```

The project id isn't a secret, so a `NEXT_PUBLIC_` variable is fine. Keep API keys for reading the
data on the server.

## Read the results

The dashboard shows the most-clicked meshes, the pointer, view-direction and gaze heatmaps,
floor-plan paths, and FPS by device. The same data is available from the
[query API](/docs/api/query/), and you can
[ask an AI agent](/docs/learn/ai-agent-3d-analytics/) about it in plain English. For each heatmap
and what it answers, see [Heatmaps for three.js scenes](/docs/learn/threejs-heatmaps/). Everything
on that page applies to R3F.

To watch a single visitor's session, replay it in your own scene with
`createThreeReplayDriver` from `@uptimizr/replay/three`. R3F scenes are three.js scenes. See
[Session replay](/docs/guides/replay/).

## Next steps

- Read the [react-three-fiber connector reference](/docs/connectors/r3f/) for WebXR hit resolution
  and the full option set.
- Read [The complete guide to analytics for three.js apps](/docs/learn/threejs-analytics/). The
  R3F connector passes every option through to it.
- Try the [live demo](https://demo.uptimizr.com) to explore the reports without installing
  anything.
