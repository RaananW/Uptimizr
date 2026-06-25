# @uptimizr/replay

Re-drive a captured session in the framework user's **own** 3D scene.
The event schema is replay-complete, so the same ordered stream that powers
analytics also reconstructs the session: camera pose, pointer travel, and picks.

The core is **framework-agnostic**; engine drivers live behind subpaths. A replay
driver only reads/writes the scene — it **never emits analytics events**.

## Install

```bash
npm install @uptimizr/replay
# Plus the engine you replay into (optional peer deps), e.g. Babylon:
npm install @babylonjs/core
```

The engine packages (`@babylonjs/core`, `@babylonjs/lite`, `three`, `playcanvas`)
are **optional peer dependencies** — install only the driver(s) you use. Replay is
a developer/debug tool and never emits analytics.

## Usage

```ts
import { ReplayPlayer, fetchSessionEvents } from "@uptimizr/replay";
import { createBabylonReplayDriver } from "@uptimizr/replay/babylon";

const events = await fetchSessionEvents({
  endpoint: "https://collect.example.com",
  apiKey: "utk_…",
  sessionId: "…",
});

const driver = createBabylonReplayDriver({
  scene,
  onPointer: (screen, hitPoint, hitMesh) => {
    /* render a pointer marker */
  },
});

const player = new ReplayPlayer(events, driver, { speed: 1, onComplete: () => {} });
player.play(); // play / pause / seek(ms) / stop
```

### Scene backdrop (load a `.glb` to re-drive over)

Replay normally re-drives into your **existing** scene. When you only have the
captured stream and no scene to host it (e.g. a hosted drag-and-drop viewer),
load an arbitrary asset as a **backdrop** first, then replay over it. The Babylon
helper accepts a URL **or** a dropped `File`:

```ts
import { loadSceneBackdrop } from "@uptimizr/replay/babylon";

// from a URL…
const backdrop = await loadSceneBackdrop(scene, "https://example.com/room.glb");
// …or from a dropped File:
// const backdrop = await loadSceneBackdrop(scene, file);

console.log(`${backdrop.meshes.length} meshes added`);

// later — swap one model for another:
backdrop.dispose();
```

`loadSceneBackdrop(scene, source, options?)` returns a handle
(`{ rootNodes, meshes, container, dispose() }`). Its `dispose()` removes
everything it added and releases the GPU resources, so the hosted slice can
replace one dropped model with the next. The default loader lazily imports
Babylon's glTF `SceneLoader`, so the lean replay path never pulls it in unless a
backdrop is actually requested; pass `options.load` to supply your own loader, or
`options.pluginExtension` to force a parser. Loaded actor/subtree nodes re-drive
exactly like any other scene node (`node_transform`, ADR 0033).

With the **global** one-call entry point, pass `backdropUrl` (it reuses the host
page's Babylon loader so the IIFE never bundles a second `SceneLoader`):

```ts
await replayInScene({
  scene,
  endpoint: "https://collect.example.com",
  apiKey: "utk_…",
  sessionId: "…",
  backdropUrl: "https://example.com/room.glb",
});
```

### three.js

The three driver lives at `@uptimizr/replay/three`. three has no
`scene.activeCamera`, so the `camera` is an explicit option:

```ts
import { ReplayPlayer, fetchSessionEvents } from "@uptimizr/replay";
import { createThreeReplayDriver } from "@uptimizr/replay/three";

const events = await fetchSessionEvents({ endpoint, apiKey, sessionId });

const driver = createThreeReplayDriver({
  scene,
  camera, // required — three has no scene.activeCamera
  onPointer: (screen, hitPoint, hitMesh, type) => {
    /* render a pointer marker */
  },
});

new ReplayPlayer(events, driver, { speed: 1 }).play();
```

Canonical (left-handed) world data is converted back to three's right-handed
frame, and camera orientation is applied via `camera.lookAt(target)` so three
resolves its −Z-forward convention internally. `three` is an **optional peer
dependency** — only needed if you use the three driver.

The replay endpoint requires `ENABLE_RAW_SESSION_RETENTION` on the collector.

## Design

- `ReplayPlayer` is driven by a pure `update(elapsedMs)`; `play()` just ticks it
  from an animation loop. Seeking backward resets the driver and replays from the
  start, so playback is deterministic.
- `ReplayDriver` is the engine extension point: implement `{ reset, apply }` for
  another engine and pass it to `ReplayPlayer`. Babylon (`@uptimizr/replay/babylon`)
  and three.js (`@uptimizr/replay/three`) drivers ship in the box.

`@babylonjs/core` and `three` are both **optional peer dependencies** — you only
need the one whose driver you import.

## Develop

```bash
pnpm --filter @uptimizr/replay build
pnpm --filter @uptimizr/replay typecheck
pnpm --filter @uptimizr/replay test
```

## License

[Apache-2.0](./LICENSE) © Uptimizr.
