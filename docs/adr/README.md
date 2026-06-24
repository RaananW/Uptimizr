# Architecture Decision Records (ADRs)

Short, immutable records of significant decisions. Each ADR captures the context, the decision,
and its consequences. When a decision changes, add a new ADR that supersedes the old one rather
than editing history.

| #                                                                  | Title                                                                  | Status     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------- |
| [0001](./0001-stack.md)                                            | Tech stack & monorepo tooling                                          | Accepted   |
| [0002](./0002-database.md)                                         | Database: ClickHouse + Postgres                                        | Accepted   |
| [0003](./0003-privacy-model.md)                                    | Cookieless, GDPR-first privacy model                                   | Accepted   |
| [0004](./0004-monorepo-separation.md)                              | Self-contained OSS monorepo                                            | Accepted   |
| [0005](./0005-backend-framework.md)                                | Backend framework: Fastify (Hono for edge later)                       | Accepted   |
| [0006](./0006-session-replay.md)                                   | Session replay on the user's own infrastructure                        | Accepted   |
| [0007](./0007-migrations.md)                                       | Hand-written SQL migrations (no ORM/framework)                         | Accepted   |
| [0010](./0010-spatial-3d-heatmaps.md)                              | Spatial (3D) heatmaps: scene dimension + camera pose                   | Proposed   |
| [0011](./0011-input-source-agnostic-events.md)                     | Input-source-agnostic interaction events (XR-ready)                    | Proposed   |
| [0012](./0012-sampling-and-fidelity.md)                            | Sampling, fidelity, and cost controls                                  | Proposed   |
| [0013](./0013-error-capture-privacy.md)                            | Opt-in runtime error capture and its privacy stance                    | Proposed   |
| [0014](./0014-scene-registry.md)                                   | Scene registry and the scene-proxy wire format                         | Accepted   |
| [0015](./0015-replay-ndjson-streaming.md)                          | NDJSON streaming for the session-replay event stream                   | Accepted   |
| [0016](./0016-work-tracking.md)                                    | Work tracking — GitHub Issues vs. Markdown docs                        | Accepted   |
| [0017](./0017-consumer-facing-agents.md)                           | Consumer-facing agent strategy (packaged knowledge + MCP)              | Accepted   |
| [0018](./0018-coordinate-frame-and-connector-provenance.md)        | Canonical world coordinate frame + connector provenance                | Accepted   |
| [0019](./0019-simplified-single-store-backend.md)                  | Simplified single-store backend (DuckDB) for self-hosting              | Superseded |
| [0020](./0020-open-core-storage-boundary.md)                       | Single-store OSS backend (DuckDB) + optional ClickHouse+PG scale tier  | Accepted   |
| [0021](./0021-graphics-backend-and-engine-diagnostics.md)          | Graphics backend metadata + opt-in engine diagnostics                  | Accepted   |
| [0023](./0023-input-action-and-keyboard-gamepad.md)                | Input-action events and the keyboard/gamepad input layer               | Accepted   |
| [0024](./0024-babylon-lite-connector.md)                           | Babylon Lite (WebGPU) connector + replay/heatmap drivers               | Accepted   |
| [0025](./0025-camera-gesture-navigation-intent.md)                 | Typed camera-gesture events (navigation vs. selection intent)          | Accepted   |
| [0026](./0026-camera-mode-aware-analytics.md)                      | Camera-mode-aware analytics (viewer vs. first-person scenes)           | Accepted   |
| [0027](./0027-scene-actor-transform-capture.md)                    | Scene-actor transform capture for replay (moving objects)              | Accepted   |
| [0028](./0028-performance-analytics-and-percentile-aggregation.md) | Performance analytics — per-session percentiles + device-aware FPS     | Accepted   |
| [0029](./0029-distribution-and-self-host-dx.md)                    | Dashboard distribution + self-host developer experience (CLI)          | Accepted   |
| [0030](./0030-world-space-gaze-heatmap.md)                         | World-space gaze heatmap (camera-pose surface hits)                    | Accepted   |
| [0031](./0031-optional-worker-offload.md)                          | Optional Web Worker offload of client-side processing                  | Accepted   |
| [0032](./0032-live-sessions-and-realtime-presence.md)              | Live sessions and real-time presence (active-now + live follow)        | Accepted   |
| [0033](./0033-actor-subtree-and-proxy-reconstruction.md)           | Actor subtree capture + proxy-driven replay reconstruction             | Accepted   |
| [0034](./0034-pointer-lock-aware-capture.md)                       | Pointer-lock-aware pointer capture (crosshair = viewport centre)       | Accepted   |
| [0035](./0035-unified-live-follow-replay-window.md)                | Unified live-follow replay window (single birdview, internal playhead) | Accepted   |
| [0036](./0036-extensible-dashboard-panels.md)                      | Extensible dashboard panel contract (build-time registry)              | Accepted   |
| [0037](./0037-aggregate-desire-line-paths.md)                      | Aggregate desire-line paths (binned per-session crowd routes)          | Accepted   |

## Template

Use [`template.md`](./template.md) for new records.
