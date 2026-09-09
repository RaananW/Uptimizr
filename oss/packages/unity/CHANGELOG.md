# @uptimizr/unity

## 0.2.1

### Patch Changes

- 7b1a9dc: Fix the engine round-trip harness on Windows, where it could not start at all. The
  playground's Vite dev server watched `e2e/.tmp/`, which holds the harness DuckDB store;
  DuckDB keeps an exclusive lock on that file for the length of a run and Windows raises
  `EBUSY` when watching a locked file, so the server died on boot and every e2e spec
  failed. Separately, `serveUnityBuild` rejected path traversal by testing for a
  `distDir + "/"` prefix, which never matches the backslash paths `resolve` returns on
  Windows — so every Unity build asset returned 403 — and `.prettierignore` did not cover
  Unity's generated `Library/`, `Temp/`, `Obj/` and `Logs/`, so building the sample project
  broke `format:check`. Harness only — no change to either published connector.
- 3c3ee66: Make the package scripts cross-platform so a fresh Windows checkout can build. `clean` now uses `rimraf` instead of `rm -rf`, and the dashboard's `build`/`build:static`/`prepack`/`start` no longer rely on a POSIX `VAR=value` prefix. No runtime or published-output change.
- 7b1a9dc: Document the connector against Unity 6. The reference project
  (`examples/unity-web-export`) moves from 2022.3 LTS to 6000.6.0f1, and the setup docs
  follow Unity 6's renames — **File → Build Profiles** replaces _Build Settings_, and the
  platform is **Web** rather than _WebGL_. A new "Input backends and picks" section spells
  out which pointer API the shim compiles against for each Active Input Handling setting,
  and warns that picks are dropped for the first few seconds of a session on the Input
  System backend (measured on 6000.6: a click as `createUnityInstance` resolves never
  reaches the bridge, the same click ~3s later always does). Documentation and sample
  only — no change to the published connector code.
- 7b1a9dc: Capture picks under either Unity input backend. `UptimizrUnityBridge.cs` read
  `UnityEngine.Input` unconditionally, which throws `InvalidOperationException` every
  frame when a project has Active Input Handling set to the Input System package — the
  common case on Unity 6 — so those projects saw exception spam and no `mesh_interaction`
  events at all. Pointer-down is now resolved through `TryGetPrimaryPointerDown`, which
  compiles a `Mouse`/`Touchscreen` path under `ENABLE_INPUT_SYSTEM` and the legacy path
  under `ENABLE_LEGACY_INPUT_MANAGER` (preferring the Input System when both are
  enabled, so a click still yields exactly one push). With neither backend enabled the
  bridge degrades to no picks instead of throwing.
- Updated dependencies [3c3ee66]
  - @uptimizr/schema@1.0.1
  - @uptimizr/sdk-core@1.0.1
  - @uptimizr/web-export@0.2.1

## 0.2.0

### Minor Changes

- 8bf70da: Ship the Unity engine-side bridge — the **copy-in asset** that unlocks the bridged capture
  tier (ADR 0045, #110). `bridge/` now contains a real `Uptimizr.jslib` Emscripten plugin and
  an example `UptimizrUnityBridge` `MonoBehaviour` (replacing the placeholder): the C# side
  samples the active `Camera` pose, raycast picks (named object + world hit point), and FPS
  each interval and pushes them over the versioned `EngineBridge` on
  `window.__uptimizr_unity__`. The shim asserts `BRIDGE_PROTOCOL_VERSION` (1) on start and does
  **no** coordinate math — it forwards Unity's native-frame (left-handed, y-up, meters) values
  and the connector applies the identity normalization. Privacy-safe per ADR 0003: only poses,
  FPS, and developer-named objects cross the boundary — no invented IDs, no raw input text.

  Docs (the connector page, package README, `bridge/README.md`, and `docs/integration.md`) now
  cover the engine-side setup (copy `Uptimizr.jslib` to `Assets/Plugins/WebGL/`, add the
  MonoBehaviour to a GameObject) alongside the zero-engine-code JS-only tier. No
  `@uptimizr/schema` change — the connector still emits only existing events.

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

- d25b1e8: Add a `node:vm` sanity test for the engine-side `Uptimizr.jslib` shim: it evaluates the
  plugin with mocked Emscripten globals, resolves the `$UptimizrUnityBridge` library object
  the way Emscripten does, and asserts every C-callable export forwards correctly to
  `window.__uptimizr_unity__` (protocol version and `-1` when absent; pose with `fov < 0`
  omitted; pick name decoded via `UTF8ToString` and empty names dropped; perf with
  `longFrames < 0` omitted; scene proxy JSON parsed and invalid / non-array input ignored),
  that every export declares its `__deps`, and that the export set matches the
  `[DllImport]`s in `UptimizrUnityBridge.cs`.

  Docs: the bridged tier is labelled **preview** until verified against a local build, and
  the README points at the new sample Unity project (`examples/unity-web-export/`) plus the
  one-step WebGL build that drives the real-export Playwright spec (#253).

- Updated dependencies [4c5f44f]
- Updated dependencies [9dd78e8]
- Updated dependencies [28e5af5]
  - @uptimizr/sdk-core@1.0.0
  - @uptimizr/schema@1.0.0
  - @uptimizr/web-export@0.2.0
