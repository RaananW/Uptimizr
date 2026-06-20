# Phase Plans

Uptimizr is built in phases. Each phase has its own document with goals, steps, deliverables,
and verification criteria.

| Phase                                  | Focus                                                                                                                           | Status      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [Phase 0](./phase-0-foundation.md)     | Repo foundation, docs, ADRs, agent tooling, CI                                                                                  | In progress |
| [Phase 1](./phase-1-oss-mvp.md)        | OSS collector: schema, SDK, multi-engine connectors (Babylon, three.js, PlayCanvas, R3F, A-Frame), ingestion, dashboard, replay | Planned     |
| [Phase 1.5](./phase-1.5-public-web.md) | Public OSS web presence: `uptimizr.com` marketing site + `uptimizr.com/docs` developer docs (no hosting messaging)              | Planned     |

Build order: **Phase 0 → Phase 1 → Phase 1.5.** No feature code lands before Phase 0 is
complete. Phase 1.5 is OSS-only public web (marketing + docs) and depends on Phase 1's surfaces
existing to document them.

## Design sketches

Mutable, pre-phase design notes (not ADRs). They hold reversible UI/rendering/implementation
choices so they can evolve without churning an immutable record.

| Sketch                                                                | Focus                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [3D heatmap rendering](./3d-heatmap-rendering-design.md)              | Rendering, viewers, and scene representation for spatial heatmaps       |
| [In-browser demo (`demo.uptimizr.com`)](./demo-in-browser-design.md)  | Backend-less side-by-side demo: DuckDB-Wasm store, SW shim, disposal    |
| [Browser & runtime event capture](./browser-events-capture-design.md) | Full scene feedback: resize, focus, visibility, errors, context loss    |
| [Dashboard improvement plan](./dashboard-improvement-plan.md)         | Filters, the time dimension (scrubber), 3D heatmap & health views       |
| [Performance section](./performance-section-design.md)                | FPS distribution, frame-time/jank, device & scene breakdown, stability  |
| [Replay data streaming](./replay-streaming-design.md)                 | NDJSON/cursor streaming vs. single-JSON replay delivery                 |
| [Scene-metrics expansion](./scene-metrics-expansion-design.md)        | New 3D metrics (dwell, coverage, jank, dead clicks) + input abstraction |
