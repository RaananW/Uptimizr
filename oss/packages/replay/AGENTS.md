# AGENTS.md — @uptimizr/replay

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

Re-drives a captured session in the framework user's **own** 3D scene (ADR 0006). Because the
event schema is replay-complete, the same ordered stream that powers analytics reconstructs the
session: camera pose, pointer travel, and picks. The core is framework-agnostic; engine drivers
live behind subpaths. A replay driver only reads/writes the scene — it **never emits analytics**.

## Install

```bash
pnpm add @uptimizr/replay
# @babylonjs/core is an optional peer dependency — only for the Babylon driver.
```

## Canonical usage

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

The replay endpoint requires `ENABLE_RAW_SESSION_RETENTION` on the collector.

## Scene backdrop

`loadSceneBackdrop(scene, source, options?)` from `@uptimizr/replay/babylon` loads an arbitrary
asset (URL or dropped `File`, e.g. a `.glb`) into the scene as a backdrop, then the normal replay
path re-drives the session over it. It returns `{ rootNodes, meshes, container, dispose() }`;
`dispose()` removes everything it added so a hosted viewer can swap one dropped model for the next.
The default loader **lazily** imports Babylon's glTF `SceneLoader`, keeping the lean replay path
free of it. The global `replayInScene({ backdropUrl })` reuses the host page's Babylon loader
(`window.BABYLON.LoadAssetContainerAsync` or an explicit `loadBackdrop`), so the IIFE build never
bundles a second `SceneLoader`; it warns and replays without a backdrop when no loader is found.

## Rules for agents

- Replay is **read-only** on the data side: a driver must never emit analytics events (ADR 0006).
- The backdrop loader only **adds scene geometry**; it must not touch the event stream.
- Keep the glTF `SceneLoader` out of the lean/global paths: the npm default loader imports it
  dynamically, and the global path resolves the host's loader instead of bundling one.
- `ReplayPlayer` is driven by a pure `update(elapsedMs)`; seeking backward resets the driver and
  replays from the start, so playback stays deterministic — preserve this contract.
- To support another engine, implement the `ReplayDriver` `{ reset, apply }` interface and pass it
  to `ReplayPlayer`.
- Treat `@babylonjs/core` as an optional peer dependency.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
