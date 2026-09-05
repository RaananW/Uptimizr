# @uptimizr/replay

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

### Patch Changes

- Updated dependencies [4c5f44f]
- Updated dependencies [9dd78e8]
  - @uptimizr/sdk-core@1.0.0
  - @uptimizr/schema@1.0.0

## 0.2.6

### Patch Changes

- 0af8209: Update runtime dependencies: Fastify 5.12.1 and @fastify/helmet 13.1.1 (collector-server), Next.js 16.3.3 and Babylon.js 9.23.0 (dashboard), and Zod 4.5.4 (schema, agent-core, mcp, replay, collector-server). Dev-only dependency bumps across the remaining packages are not released.
- Updated dependencies [0af8209]
  - @uptimizr/schema@0.6.1
  - @uptimizr/sdk-core@0.5.1

## 0.2.5

### Patch Changes

- Updated dependencies [0e8b8a8]
- Updated dependencies [6d883d0]
- Updated dependencies [8041ca2]
  - @uptimizr/schema@0.6.0
  - @uptimizr/sdk-core@0.5.0

## 0.2.4

### Patch Changes

- 59fd29b: docs: refresh package and app READMEs to match current source

  Reconcile every package/app README with the actual code — corrected package/connector
  lists, public APIs and options, CLI flags, env vars, ports, the event catalog, and
  cross-links. Also drop "Google Analytics" references in favor of neutral "web analytics"
  wording. Documentation-only; no runtime behavior changes.

- Updated dependencies [59fd29b]
  - @uptimizr/schema@0.5.1
  - @uptimizr/sdk-core@0.4.1

## 0.2.3

### Patch Changes

- Updated dependencies [e39cbc7]
- Updated dependencies [3c0a20b]
- Updated dependencies [3193a21]
  - @uptimizr/schema@0.5.0
  - @uptimizr/sdk-core@0.4.0

## 0.2.2

### Patch Changes

- d71b284: Roll up the open Dependabot updates into a single dependency bump. Refresh
  engine peers and tooling (Babylon.js 9.14, Babylon Lite 1.6, three.js 0.185,
  PlayCanvas 2.20, @clickhouse/client 1.22, fastify-type-provider-zod 7,
  fastify 5.9, astro 7, @types/node 26, plus the minor/patch group and CI
  actions). No public API changes. Babylon Lite 1.6 reads WebGPU bitmask
  globals at import time, so the lite connector's vitest run now stubs those
  globals via a setup file.
- Updated dependencies [092ef4b]
- Updated dependencies [08c4abd]
- Updated dependencies [16fc907]
- Updated dependencies [268ea8f]
- Updated dependencies [73f342d]
- Updated dependencies [23f308d]
  - @uptimizr/sdk-core@0.3.0
  - @uptimizr/schema@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [fa6c472]
- Updated dependencies [76a8060]
- Updated dependencies [32248e0]
  - @uptimizr/schema@0.3.0
  - @uptimizr/sdk-core@0.2.0

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
