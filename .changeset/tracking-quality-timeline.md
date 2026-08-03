---
"@uptimizr/schema": minor
"@uptimizr/sdk-core": minor
"@uptimizr/babylon": minor
"@uptimizr/db": minor
"@uptimizr/react": minor
---

Add an XR **tracking-quality timeline** (#155, ADR 0048) by extending the existing
`capability_change` event with a new `"tracking"` kind — events live once, no new
event type, no DB migration.

- **schema.** `capabilityChangeKindSchema` gains `"tracking"`, and
  `capabilityChangeSchema` now spreads `inputSourceShape` (`source` / `handedness`)
  and an optional `durationMs` (the completed degraded-episode length). A tracking
  transition reuses the event's existing `from` / `to` / `reason` shape (e.g.
  `"hand"` → `"lost"`, `"6dof"` → `"3dof"`).
- **sdk-core.** `reportCapabilityChange(...)` threads `source` / `handedness` /
  `durationMs` through, and the XR capture options gain a `tracking` toggle.
- **@uptimizr/babylon.** The XR collector reports coarse, best-effort tracking
  loss/recovery — when a hand or controller drops out of the input registry
  mid-session it emits one `capability_change { kind: "tracking" }` per completed
  degraded episode (via the same `reportCapabilityChange` path as `device-recovery`).
- **@uptimizr/db.** New dialect-agnostic `buildTrackingQuality(projectId, opts, d)`
  aggregation (per session: `degraded_ms`, `hand_degraded_ms`,
  `controller_degraded_ms`, `degraded_episodes`, span) plus a `PARITY_CASES` entry so
  DuckDB and ClickHouse stay provably equal. The degraded duration reuses the shared
  `visible_ms` column.
- **@uptimizr/react.** New `trackingQuality()` API method (`GET /api/v1/xr/tracking`)
  and a **Tracking quality** catalog panel (share of session time degraded, split by
  hand vs. controller) surfaced on the overview alongside scene health.
