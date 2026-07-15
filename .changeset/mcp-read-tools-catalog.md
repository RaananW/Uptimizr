---
"@uptimizr/agent-core": minor
---

feat(agent-core): add read tools for funnels, desire-line paths, rendering technology, and XR analytics

Extend the shared read-only tool catalog with one entry per existing aggregate query endpoint:
`funnel` (ADR 0038), `aggregate_paths` (ADR 0037), `rendering_technology` (ADR 0046), and the XR
comfort/usage tools `xr_rotation` / `xr_sources` / `xr_abandonment` / `xr_locomotion` (ADR 0048).
The surface stays strictly aggregate and read-only (ADR 0003 / ADR 0017).
