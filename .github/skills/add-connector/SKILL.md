---
name: add-connector
description: Add a new 3D engine connector (e.g. three.js, PlayCanvas, react-three-fiber) to Uptimizr, mirroring the Babylon adapter. USE FOR: supporting a new 3D engine, new framework adapter, new collector SDK. Trigger phrases: add a connector, support three.js, new engine adapter, port the SDK to <engine>.
---

# Skill: Add a new 3D engine connector

Create a new collector adapter for a 3D engine, mirroring `@uptimizr/babylon`. Connectors
depend only on `@uptimizr/sdk-core` and `@uptimizr/schema`.

> Scope: the first public release ships connectors for Babylon, three.js, PlayCanvas, R3F, and
> A-Frame (Phase 1, see `docs/phases`). Engines beyond that set (Wonderland, Needle, Spline, raw
> WebGPU/WebGL) are follow-ups — confirm intent before building one.

## Steps

1. **Scaffold the package.**
   - Create `oss/packages/sdk-<engine>/` with its own `package.json`
     (`@uptimizr/<engine>`) and `tsconfig.json` extending the base config. ESM only.
   - Add the engine library as a **peer dependency**, not a hard dependency.

2. **Implement capture against the shared core.**
   - Use `@uptimizr/sdk-core` for session, batching, and transport.
   - Emit the same `@uptimizr/schema` events the Babylon adapter does, where the engine
     supports them: `session_start/end` (with device/GPU caps), `frame_perf`, `camera_sample`,
     `pointer_move`/`pointer_click` (screen + raycast hit + object name), `mesh_interaction`,
     `asset_load`, and a `track()` passthrough.
   - Map engine concepts to the schema faithfully (camera pose, raycasting, named objects).
     Don't invent fields outside the schema.

3. **Coordinate frame & connector provenance (ADR 0018).**
   - The canonical wire frame for **world-space** data is **left-handed, y-up, unit scale 1**
     (Babylon-native). If the engine is **right-handed** (three.js, PlayCanvas, glTF), normalize
     every world-space value to canonical **at the emission boundary**. Use the shared helpers in
     `@uptimizr/sdk-core` — `toCanonicalPosition`, `toCanonicalDirection`, `toCanonicalAabb`
     (pass the source `handedness`) — for positions, directions, `hitPoint`, and scene-proxy AABB
     bounds. Screen-space and direction-sphere data are already engine-independent; leave them as-is.
   - ⚠️ **RHS→LHS is not just "negate Z" for camera orientation.** The frame helpers are correct for
     world-space positions/directions/AABBs, but a camera's _look direction_ is convention-dependent
     (three.js cameras look along local **−Z**; the canonical camera along **+Z**). Capture the
     camera's orientation as a **world-space forward (and up) vector**, then pass it through
     `toCanonicalDirection`. If you reconstruct orientation from a local quaternion / Euler instead,
     you must also apply a rotation (forward-axis flip / ~180° about up) — component reflection alone
     is wrong. See `coordinates.ts` for the full caveat.
   - Emit a `connector` block on `session_start` (`client.start({ connector })`) with `name`
     (engine id, e.g. `"three"`), optional library `version`, and `coordinateSystem` describing
     the engine's **native** frame (`handedness`, `upAxis`, `unitScale`). This is provenance — the
     payload is canonical; `coordinateSystem` records what the source frame was. Mirror
     `@uptimizr/babylon`'s `readConnector`.
   - Set `handedness` on any scene proxy the connector produces (`scanSceneProxy` equivalent).
   - Add a unit test asserting world-space values are canonical (e.g. a right-handed input yields a
     Z-negated tuple) and that the `connector` provenance is correct.

4. **Graphics backend metadata (ADR 0021).**
   - Emit a `graphics` block on `session_start` (`client.start({ graphics })`) describing the
     underlying rendering technology: `api` (e.g. `webgl2`/`webgpu`), the real `backend` behind it
     when discoverable, `apiVersion`, and `shadingLanguage`. Always-on, non-PII, low-cardinality
     metadata. Mirror `@uptimizr/babylon`'s `readGraphics` (read defensively; leave fields unset
     when the engine doesn't expose them).

5. **Lifecycle & options.**
   - Expose sampling-rate options; register and clean up all listeners/observers on `dispose()`.
   - No cookies / no persistent client IDs (ADR 0003).

6. **Replay (optional but recommended).**
   - Add a matching driver in `@uptimizr/replay` so sessions captured with this engine can be
     re-driven in the user's own scene.

7. **Example + tests.**
   - Add an `examples/<engine>-playground` demo wired to the collector.
   - Unit-test event construction; ensure `pnpm lint typecheck build test` passes.

## Checklist

- [ ] New `@uptimizr/<engine>` package depends only on sdk-core + schema (+ engine peer dep)
- [ ] Emits standard schema events; no schema redefinition
- [ ] World-space data normalized to the canonical frame; `connector` provenance emitted (ADR 0018)
- [ ] `graphics` backend metadata emitted on `session_start` (ADR 0021)
- [ ] `dispose()` cleans up; no persistent client IDs
- [ ] Optional replay driver added
- [ ] Example playground + tests; CI green
