# `examples/`

Runnable demos used for manual and end-to-end testing of the OSS collector.

- `playground` _(Phase 1)_ — one app that serves **all five engine connectors**
  (Babylon.js, three.js, PlayCanvas, react-three-fiber, A-Frame/WebXR) from a single
  Vite build. Pick an engine from the in-app selector; the app reloads with
  `?engine=<id>` and dynamic-imports only that engine's chunk. Wired to the engine
  connectors + `@uptimizr/replay`, pointed at a locally running `collector-server`.
  Used to generate real events and verify capture, heatmaps, and session replay end
  to end. See its `README.md` for the engine capability matrix, env vars, and the
  Playwright e2e harness.

Run it from the repo root with `pnpm dev:playground` (or
`pnpm --filter @uptimizr/example-playground dev`).
