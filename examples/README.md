# `examples/`

Runnable demos used for manual and end-to-end testing of the OSS collector.

- `playground` _(Phase 1)_ — one app that serves **all six engine connectors**
  (Babylon.js, Babylon Lite, three.js, PlayCanvas, react-three-fiber, A-Frame/WebXR) from a single
  Vite build. Pick an engine from the in-app selector; the app reloads with
  `?engine=<id>` and dynamic-imports only that engine's chunk. Wired to the engine
  connectors + `@uptimizr/replay`, pointed at a locally running `collector-server`.
  Used to generate real events and verify capture, heatmaps, and session replay end
  to end. See its `README.md` for the engine capability matrix, env vars, and the
  Playwright e2e harness.

- `godot-web-export` — the **reference integration** for the `@uptimizr/godot` bridged
  tier (ADR 0045, #252): a minimal Godot 4 project with the `UptimizrGodot.gd` autoload
  (a checked byte-identical copy of the package shim), a `Camera3D`, and named pickable
  props. Not a pnpm package — CI exports it headlessly to WebAssembly
  (`pnpm godot:fetch && pnpm godot:export`) and the playground's
  `e2e/godot-export.spec.ts` boots the export in-page to prove the shim runs
  (`pnpm test:e2e:godot`). See its `README.md`.

Run the playground from the repo root with `pnpm dev:playground` (or
`pnpm --filter @uptimizr/example-playground dev`).
