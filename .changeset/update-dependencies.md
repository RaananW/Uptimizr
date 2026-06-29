---
"@uptimizr/db-clickhouse": patch
"@uptimizr/babylon": patch
"@uptimizr/babylon-lite": patch
"@uptimizr/playcanvas": patch
"@uptimizr/three": patch
"@uptimizr/r3f": patch
"@uptimizr/aframe": patch
"@uptimizr/replay": patch
"@uptimizr/heatmap": patch
---

Roll up the open Dependabot updates into a single dependency bump. Refresh
engine peers and tooling (Babylon.js 9.14, Babylon Lite 1.6, three.js 0.185,
PlayCanvas 2.20, @clickhouse/client 1.22, fastify-type-provider-zod 7,
fastify 5.9, astro 7, @types/node 26, plus the minor/patch group and CI
actions). No public API changes. Babylon Lite 1.6 reads WebGPU bitmask
globals at import time, so the lite connector's vitest run now stubs those
globals via a setup file.
