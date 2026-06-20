---
title: three.js
description: Instrument a three.js scene with the @uptimizr/three connector.
---

The three.js connector. `three` is a peer dependency — the connector reads your existing three.js
instance and never bundles or mutates it.

## Install

```bash
npm install @uptimizr/three three
```

## Usage

Because three.js has no `scene.activeCamera` and the connector reads FPS and the canvas from the
renderer, `camera` and `renderer` are explicit arguments:

```ts
import { trackScene } from "@uptimizr/three";

const client = trackScene(scene, camera, renderer, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

// later, on teardown
await client.stop("manual");
```

`trackScene` creates the client, registers the collector, reads device/GPU caps, and starts the
session. It returns the `@uptimizr/sdk-core` `UptimizrClient`, so you can read `client.sessionId`,
emit custom events, or stop it.

## Coordinate frame

World-space data is normalized from three's native **right-handed, y-up** frame to the canonical
wire frame (**left-handed, y-up**) at the emission boundary. The session is attributed to the
`three` connector and records three's native frame in `connector.coordinateSystem`.

## Capture

Captures camera pose → view-direction heatmap, pointer move/click (with optional raycast hit) →
screen heatmaps, mesh picks → object engagement, and FPS → performance. Opt-in: mesh visibility,
hover dwell, and resource sample.

## Advanced

For a custom transport, a `beforeSend` hook, or registering multiple collectors, compose the pieces
directly:

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { threeCollector, readDeviceCaps } from "@uptimizr/three";

const client = new UptimizrClient({ projectId: "your-project", endpoint: "https://collect.example.com" });
client.use(threeCollector({ scene, camera, renderer }));
client.start({ device: readDeviceCaps(renderer) });
```

See [sdk-core (advanced)](/docs/connectors/sdk-core/) for the full client API.
