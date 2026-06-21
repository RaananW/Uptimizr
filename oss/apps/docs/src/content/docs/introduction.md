---
title: Introduction
description: What Uptimizr captures, how the pieces fit together, and the principles behind the project.
---

Uptimizr is a **3D-scene analytics platform** — like Google Analytics, but for 3D apps. It captures
view-direction heatmaps, pointer/click heatmaps, mesh interactions, session and performance metrics,
and custom events from a 3D scene, and can **replay** a recorded session inside your own scene.

## What it captures

- **View-direction (gaze) heatmaps** — where users actually look, projected into world space and
  onto meshes.
- **Pointer & click heatmaps** — hover and click density, ray-cast into the scene and aggregated
  onto surfaces.
- **Mesh interactions** — which objects get hovered, picked, and ignored, ranked with dwell time.
- **Session & performance** — FPS, frame time, draw calls, device class, with percentile
  aggregation.
- **Session replay** — re-drive a recorded session from an ordered, timestamped event stream.
- **Custom events** — your own domain events (`add_to_cart`, `level_complete`, …) on the same
  envelope.

## How it fits together

```text
 3D scene ──connector──▶ sdk-core ──beacon──▶ collector ──▶ store
   (Babylon/three/…)     (batch/flush)     POST /api/v1/collect   (DuckDB or ClickHouse)
                                                       │
                                              query API (x-api-key)
                                                       │
                                                  dashboard / MCP / your app
```

1. A **connector** (e.g. `@uptimizr/babylon`) observes your scene and emits events.
2. **`@uptimizr/sdk-core`** batches them and sends them over `navigator.sendBeacon`.
3. The **collector** validates and stores them, scoped to a project by API key.
4. The **dashboard** (or the read-only MCP server, or your own code) queries aggregates back out.

## Principles

- **One source of truth for events.** Every event shape is a Zod schema in `@uptimizr/schema`.
  Events are replay-complete: ordered, timestamped, and keyed by `sessionId`.
- **Privacy first.** No cookies, no persistent client IDs, no PII by default. The visitor ID is a
  server-side, daily-rotating hash. Raw per-session retention is opt-in.
- **Self-hostable.** The OSS collector and dashboard run on your own infrastructure. Your data
  never leaves unless you send it.

Ready to wire it up? Head to the [Quickstart](/docs/quickstart/).
