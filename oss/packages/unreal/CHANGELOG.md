# @uptimizr/unreal

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

- 6edeafe: Ship the Unreal engine-side bridge shim and record the web-target feasibility finding
  (ADR 0045, #112).

  The spike confirmed that while Epic has **no official UE5 HTML5/WASM target** (deprecated
  after UE 4.24) and Pixel Streaming is server-side, real **Emscripten-based, client-side**
  Unreal web exports that render into a `<canvas>` and expose the `EM_JS` / `cwrap` interop
  seam **do** exist — the community UE4.24–4.27 HTML5 forks and the experimental UE5.1–5.4
  WASM+WebGPU toolchain (Wonder Interactive / SimplyStream). The connector is therefore
  **best-effort** but the bridge model is implementable today.

  `oss/packages/unreal/bridge/` now ships the actual copy-in shim (`Uptimizr.h` +
  `Uptimizr.cpp`): EM_JS glue that samples the active `APlayerCameraManager` pose, raycast
  picks, and FPS each frame and pushes **raw** Unreal values (left-handed, z-up, centimeters)
  over `window.__uptimizr_unreal__`; a `cwrap`-callable `extern "C"` init that **asserts the
  bridge protocol version**; and no-op fallbacks outside Emscripten. No public TypeScript
  surface change — the connector still owns the single z-up→y-up + cm→m normalization path.
  Privacy unchanged (ADR 0003): only poses, FPS, and developer-named objects cross the bridge.

- Updated dependencies [4c5f44f]
- Updated dependencies [9dd78e8]
- Updated dependencies [28e5af5]
  - @uptimizr/sdk-core@1.0.0
  - @uptimizr/schema@1.0.0
  - @uptimizr/web-export@0.2.0
