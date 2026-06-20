---
description: Conventions for the SDK packages (sdk-core, sdk-babylon, replay) — browser runtime.
applyTo: "oss/packages/{sdk-core,sdk-babylon,replay}/**"
---

# SDK conventions (client runtime)

These packages run in the **end-user's browser** inside the developer's 3D app. They must be
small, dependency-light, and side-effect-free on import.

## General

- Ship ESM. Keep bundle size minimal; avoid heavy dependencies.
- Import event types from `@uptimizr/schema`; never redefine them.
- No analytics package may set cookies or create a persistent client-side identifier
  (ADR 0003). Sessions are in-memory only.
- `sdk-babylon` and `replay` must treat `@babylonjs/core` as a **peer dependency**, never a hard
  dependency, so they don't ship their own Babylon copy.

## `@uptimizr/sdk-core`

- Owns session lifecycle, an in-memory **batching queue**, and a transport built on
  `navigator.sendBeacon` (with a `fetch` keepalive fallback) plus retry/backoff.
- Configuration: `projectId`, collector `endpoint`, sampling rates, and flush thresholds.
- Flush on batch-size, on an interval, and on `visibilitychange`/`pagehide`.
- Framework-agnostic: no Babylon or DOM-3D specifics here.

## `@uptimizr/babylon`

- Observes a Babylon `Scene`/`Engine` and emits schema events: camera sampling, pointer
  move/click (screen-normalized + 3D raycast hit + mesh name), mesh interaction on named meshes,
  `frame_perf` (FPS/frame time), `asset_load` timings, and a device/GPU block from
  `engine.getCaps()` covering **both** WebGL2 and WebGPU.
- Expose sampling rates as options (perf vs. fidelity trade-off). Provide a `track(name, props)`
  passthrough for custom events.
- Clean up all observers/listeners on `dispose()`.

## `@uptimizr/replay`

- A framework-agnostic replay **core** plus a **Babylon driver**.
- Given a session's ordered event stream (from `GET /api/v1/sessions/:id/events`) and the user's
  own scene, re-drive camera/pointer/picks faithfully against event timestamps.
- Replay must not emit new analytics events (no feedback loop).
