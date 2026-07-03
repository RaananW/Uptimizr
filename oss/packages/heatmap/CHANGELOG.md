# @uptimizr/heatmap

## 0.1.2

### Patch Changes

- d71b284: Roll up the open Dependabot updates into a single dependency bump. Refresh
  engine peers and tooling (Babylon.js 9.14, Babylon Lite 1.6, three.js 0.185,
  PlayCanvas 2.20, @clickhouse/client 1.22, fastify-type-provider-zod 7,
  fastify 5.9, astro 7, @types/node 26, plus the minor/patch group and CI
  actions). No public API changes. Babylon Lite 1.6 reads WebGPU bitmask
  globals at import time, so the lite connector's vitest run now stubs those
  globals via a setup file.

## 0.1.1

### Patch Changes

- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.

## 0.1.0

### Minor Changes

- b2b7b44: Initial public release of Uptimizr — open-source, privacy-first analytics for 3D scenes.

  This first `0.1.0` ships the full open-source data collector: the `@uptimizr/schema` event
  contracts, the `@uptimizr/sdk-core` runtime, engine connectors (`@uptimizr/babylon`,
  `@uptimizr/babylon-lite`, `@uptimizr/three`, `@uptimizr/r3f`, `@uptimizr/aframe`,
  `@uptimizr/playcanvas`, `@uptimizr/react`), session `@uptimizr/replay`, the `@uptimizr/heatmap`
  renderer, the embedded-store `@uptimizr/db` layer, the `@uptimizr/mcp` server, and the
  `@uptimizr/collector-server` ingestion/query API plus the `@uptimizr/dashboard`.
