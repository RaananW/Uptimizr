# @uptimizr/godot

## 0.2.0

### Minor Changes

- 28e5af5: Add the **web-export engine connector** shared foundation and thin Unity / Godot / Unreal
  connector packages (ADR 0045, #111).

  New `@uptimizr/web-export` package provides the three reusable pieces every web-export connector is
  built from: (1) a **versioned JS bridge contract** (`createEngineBridge`, `EngineBridge`,
  `BRIDGE_PROTOCOL_VERSION`) — the tiny, stable API a thin engine-side WASM shim calls to push
  world-space pose / picks / perf / scene-proxy across the JS interop boundary; (2) a **JS-only
  (zero-engine-code) capture tier** (`startJsOnlyCapture`) — pointer move/click heatmaps, rAF FPS +
  long-frame perf, and JS error capture driven purely from the `<canvas>` DOM, working for any web
  export with no engine changes; and (3) **native-frame normalization** (`normalizePosition`,
  `normalizeDirection`, `normalizeAabb`, `rebaseZUpToYUp`) that converts each engine's world-space
  data to the canonical wire frame (left-handed, y-up, unit scale 1 — ADR 0018), including the Unreal
  z-up→y-up rebase and centimeter→meter scale. Plus `webExportCollector` and a one-call
  `trackWebExport`. No `@uptimizr/schema` change is required — connectors emit only existing events.

  New `@uptimizr/unity`, `@uptimizr/godot`, and `@uptimizr/unreal` packages are thin wrappers over
  `@uptimizr/web-export` with each engine's native frame baked in (Unity: left-handed, y-up, meters —
  canonical; Godot: right-handed, y-up, meters — negate Z; Unreal: left-handed, z-up, centimeters —
  rebase + scale, best-effort per ADR 0045). Each exposes `<engine>Collector()` and
  `track<Engine>()`, and ships a `bridge/` placeholder documenting the engine-side copy-in shim
  contract. Full per-engine WASM shims (Unity `.jslib`, Godot `JavaScriptBridge`, Unreal `EM_JS`)
  are left to the per-engine sub-issues.

### Patch Changes

- 99db045: Ship the Godot 4 engine-side bridge as a copy-in asset, unlocking the connector's bridged
  tier (ADR 0045, #113). Adds working `bridge/UptimizrGodot.gd` (GDScript) and
  `bridge/UptimizrGodot.cs` (C#) autoloads that use `JavaScriptBridge` to read the active
  `Camera3D` world pose (forward `-basis.z`, up `basis.y`, fov in radians), FPS, left-click
  raycast picks (named collider + world hit point), and an opt-in scene proxy, then push them
  over `window.__uptimizr_godot__`. The shim asserts the bridge protocol version, guards on
  `OS.has_feature("web")` (no-op off the Web export), pushes world-space values in Godot's
  native right-handed/y-up/meters frame (the connector negates Z), and stays privacy-safe
  (ADR 0003): only poses, FPS, and developer-named objects — no invented IDs, no raw input.
  The public TypeScript surface is unchanged; the JS-only tier still works with no engine code.
- 99db045: Fix `bridge/UptimizrGodot.gd` failing to compile under Godot 4's default warning settings:
  `JavaScriptBridge.create_object(...)` is vararg, so `var nodes := ...` inferred `Variant` and
  tripped `inference_on_variant` (an error by default), which made the autoload silently never
  load — the bridged tier then captured nothing. The two declarations now carry an explicit
  `JavaScriptObject` type. Caught by the new automated proof of the bridged tier (#252): a
  headless Godot 4.7.2 Web export of the reference sample project
  (`examples/godot-web-export`) driven by Playwright, which asserts `camera_sample`,
  `mesh_interaction`, `frame_perf`, and the scene proxy reach the collector with Godot's
  right-handed frame normalized. The README now states the tier's verification status and
  points at the sample as the reference integration.
- Updated dependencies [4c5f44f]
- Updated dependencies [9dd78e8]
- Updated dependencies [28e5af5]
  - @uptimizr/sdk-core@1.0.0
  - @uptimizr/schema@1.0.0
  - @uptimizr/web-export@0.2.0
