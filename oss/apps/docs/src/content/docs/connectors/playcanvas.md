---
title: PlayCanvas
description: Instrument a PlayCanvas app with the @uptimizr/playcanvas connector.
---

The PlayCanvas connector. `playcanvas` is a peer dependency — the connector reads your existing
PlayCanvas instance and never bundles or mutates it.

## Install

```bash
npm install @uptimizr/playcanvas playcanvas
```

## Usage

Because PlayCanvas supports multiple camera entities with no single "active" camera, and the
connector reads FPS and the canvas from `app.graphicsDevice`, the camera `Entity` is an explicit
argument:

```ts
import { trackScene } from "@uptimizr/playcanvas";

const client = trackScene(app, cameraEntity, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});

// later, on teardown
await client.stop("manual");
```

`trackScene` returns the `@uptimizr/sdk-core` `UptimizrClient`. Read `client.sessionId`, emit custom
events, or stop the session early.

## Coordinate frame

World-space data is normalized from PlayCanvas' native **right-handed, y-up** frame to the canonical
wire frame (**left-handed, y-up**) at the emission boundary; the session is attributed to the
`playcanvas` connector.

## Capture

Captures camera pose, pointer move/click (with optional raycast hit), mesh picks, and FPS. Opt-in:
mesh visibility and hover dwell. It tears down all DOM listeners, timers, and `frameend` handlers on
stop.

## Advanced

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { playcanvasCollector, readDeviceCaps } from "@uptimizr/playcanvas";

const client = new UptimizrClient({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
client.use(playcanvasCollector({ app, camera: cameraEntity }));
```

See [sdk-core (advanced)](/docs/connectors/sdk-core/) for the full client API.
