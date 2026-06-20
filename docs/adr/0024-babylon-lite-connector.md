# ADR 0024: Babylon Lite (WebGPU) connector

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Project owner, engineering

## Context

[`@babylonjs/lite`](https://www.npmjs.com/package/@babylonjs/lite) is a new, tree-shaken,
**WebGPU-only** distribution of Babylon.js published by the official Babylon.js org (same npm
maintainer as `@babylonjs/core`). Unlike `@babylonjs/core`'s class-based OO API, Lite exposes a
**functional / data-oriented API**: free functions operate on context structs
(`createEngine → createSceneContext → addToScene → registerScene → startEngine`), there is no
`Scene` class carrying observables, the host drives the render loop (`renderFrame(engine, delta)`),
and picking is **asynchronous and GPU-based** (`createGpuPicker` + `await pickAsync`).

Our `add-connector` workflow ([skill](../../.github/skills/add-connector/SKILL.md)) assumes a
connector can be modelled on `@uptimizr/babylon`. That assumption does not hold for Lite: its
paradigm is closer to the three.js / PlayCanvas connectors (the app owns the canvas and DOM input,
hits are resolved with an explicit picker), but with two further differences — picking is async and
the per-frame hook (`onBeforeRender(scene, cb)`) returns `void` (no unsubscribe handle).

Two facts needed an explicit decision before building:

1. **Licensing.** At publish time `@babylonjs/lite`'s npm metadata carried no SPDX `license` field
   (npm rendered it as "Proprietary"). This is a packaging mistake — Babylon Lite is Apache-2.0,
   like the rest of Babylon.js. An Apache-2.0 OSS connector lists it only as an **optional peer
   dependency** (the engine is the host's runtime choice), so the boundary is clean regardless.
2. **Coordinate frame.** Lite is **left-handed, y-up, unit-scale 1** — identical to the canonical
   wire frame (ADR 0018) — so no axis conversion is required, but provenance must still record the
   source frame.

## Decision

Add a first-class Babylon Lite connector and its replay + heatmap drivers, mirroring the existing
connectors' contracts while adapting to Lite's functional API.

### 1. Connector — `@uptimizr/babylon-lite` (`oss/packages/sdk-babylon-lite`)

- Depends only on `@uptimizr/sdk-core` + `@uptimizr/schema`; `@babylonjs/lite` is an **optional
  peer dependency** (`^1.0.1`), never bundled (esbuild keeps it external).
- `trackScene(scene, camera, canvas, options)` — Lite has no `scene.activeCamera` and the app owns
  the canvas, so both are explicit positional arguments (as with the three connector's
  `camera, renderer`).
- Emits the standard `@uptimizr/schema` events (no redefinition): `camera_sample`, `frame_perf`,
  `pointer_move` / `pointer_click`, `pointer_down` / `pointer_up`, and `mesh_interaction`. The
  universal channels only — the opt-in dwell/hover/resource channels are deferred (see below).
- **Camera pose:** position = world-matrix translation `[12,13,14]`; forward = world `+Z` basis
  `[8,9,10]` (Babylon's `getDirection(Z)`); `fov` emitted directly (radians). For an
  `ArcRotateCamera` the look-at `target` is emitted so replay is unambiguous.
- **FPS:** derived from the `deltaMs` Lite passes to `onBeforeRender` (an exponential moving
  average), since Lite exposes no `getFps()`.
- **Picking:** DOM listeners on the host canvas resolve hits via `createGpuPicker` +
  `await pickAsync`. Because picking is async, late resolutions after `stop()` are dropped via a
  `disposed` flag; the connector disposes any picker it created.
- **Provenance (ADR 0018):** `connector.coordinateSystem = { handedness: "left", upAxis: "y",
unitScale: 1 }`. World-space values pass through `toCanonical*` at the emission boundary even
  though those helpers are identities for a left-handed source, keeping the boundary uniform.
- **Graphics (ADR 0021):** `{ api: "webgpu", shadingLanguage: "wgsl" }`. The concrete backend
  (Metal/D3D12/Vulkan) and `apiVersion` need an async adapter round-trip and are left unset.
- **Privacy (ADR 0003):** no cookies, no persistent IDs; `dispose()` clears every timer, DOM
  listener, the per-frame hook (guarded by `disposed`), and the GPU picker.

### 2. Replay driver — `@uptimizr/replay/babylon-lite`

A driver that re-drives camera pose in the host's own Lite scene and forwards pointer / mesh /
custom / input-action / lifecycle / error events to host callbacks. Since Lite is left-handed, the
`fromCanonical*` helpers are identities; they are still called for symmetry. It only reads/writes
the scene — never emits analytics events (ADR 0006).

### 3. Heatmap driver — `@uptimizr/heatmap/babylon-lite`

A Tier-0 in-scene overlay (ADR 0010) drawing heat voxels as one thin-instanced, unlit box in the
host Lite scene via `setThinInstances` / `setThinInstanceColors`. The `followCamera` gaze-dome
mode is deferred.

### 4. Playground

A sixth engine module (`"babylon-lite"`) is added to `examples/playground`. It is **excluded from
the Playwright e2e flow** because headless Chromium's WebGPU support is unreliable in CI (the same
treatment A-Frame gets for its CDN dependency).

## Consequences

### Positive

- Babylon Lite scenes get the full Uptimizr capture + replay + heatmap story.
- Establishes the pattern for **functional / async-picking / app-driven-loop** engines, which the
  next wave of WebGPU engines will share.
- Confirms the canonical frame (ADR 0018) needs no conversion for a Babylon-native source.

### Negative / trade-offs

- A second Babylon connector (`@uptimizr/babylon` for core, `@uptimizr/babylon-lite` for Lite)
  with no shared code, because the APIs share no surface.
- WebGPU-only: no automated e2e coverage in CI; the connector is exercised by unit tests with
  structural stubs plus manual playground verification.
- `graphics.backend`/`apiVersion`, the gaze-dome `followCamera` mode, scene-proxy scanning, and the
  opt-in `mesh_visibility` / `hover_dwell` / `resource_sample` channels are deferred follow-ups.

## Alternatives considered

- **Extend `@uptimizr/babylon` to also handle Lite** — rejected; the APIs share no surface, so a
  shared package would be two implementations behind one name.
- **Block on the upstream license-metadata fix** — rejected; Babylon Lite is Apache-2.0 and is
  referenced only as an optional peer dependency, so there is no licensing exposure for the
  Apache-2.0 connector. The packaging fix is tracked upstream.
- **Generic raw-WebGPU connector instead of a Lite-specific one** — rejected for now; a
  Lite-specific connector reads camera/mesh/pick semantics directly, which a raw-WebGPU layer
  cannot.
