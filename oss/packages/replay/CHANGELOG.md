# @uptimizr/replay

## 0.2.0

### Minor Changes

- c2d73bf: feat(replay): load a `.glb` backdrop and re-drive a session over it (#80)

  Add a Babylon-only scene-backdrop loader so replay can bring its own scene when the host has none
  (e.g. a hosted drag-and-drop viewer). Exposed two ways: a standalone
  `loadSceneBackdrop(scene, source, options?)` from `@uptimizr/replay/babylon` (accepts a URL or a
  dropped `File`, returns a disposable `{ rootNodes, meshes, container, dispose() }` handle), and a
  `backdropUrl` option on the global `replayInScene`. The npm helper lazily imports Babylon's glTF
  `SceneLoader`, and the global path reuses the host page's loader, so neither the lean driver path
  nor the IIFE build bundles a second copy of the loader. Loaded actor/subtree nodes re-drive exactly
  like any other scene node (`node_transform`, ADR 0033).

  The dashboard's **Session replay** birdview gains a no-code **Load model (.glb)** control: load a
  glTF to replace the wireframe AABB proxy boxes with the real model and re-drive the session over it
  (replace/remove restores the boxes). The model is loaded in the browser only — nothing is uploaded.

## 0.1.2

### Patch Changes

- Updated dependencies [9e22ebd]
  - @uptimizr/schema@0.2.0
  - @uptimizr/sdk-core@0.1.2

## 0.1.1

### Patch Changes

- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.
- Updated dependencies [df5b66b]
  - @uptimizr/sdk-core@0.1.1
  - @uptimizr/schema@0.1.1

## 0.1.0

### Minor Changes

- b2b7b44: Initial public release of Uptimizr — open-source, privacy-first analytics for 3D scenes.

  This first `0.1.0` ships the full open-source data collector: the `@uptimizr/schema` event
  contracts, the `@uptimizr/sdk-core` runtime, engine connectors (`@uptimizr/babylon`,
  `@uptimizr/babylon-lite`, `@uptimizr/three`, `@uptimizr/r3f`, `@uptimizr/aframe`,
  `@uptimizr/playcanvas`, `@uptimizr/react`), session `@uptimizr/replay`, the `@uptimizr/heatmap`
  renderer, the embedded-store `@uptimizr/db` layer, the `@uptimizr/mcp` server, and the
  `@uptimizr/collector-server` ingestion/query API plus the `@uptimizr/dashboard`.

### Patch Changes

- Updated dependencies [b2b7b44]
  - @uptimizr/schema@0.1.0
  - @uptimizr/sdk-core@0.1.0
