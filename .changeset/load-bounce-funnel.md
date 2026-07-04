---
"@uptimizr/db": minor
"@uptimizr/react": minor
---

feat: load → bounce/abandon funnel (#152). Adds a `buildLoadBounceFunnel` query
builder that buckets sessions by their initial `asset_load` time band and counts
how many bounced (no `pointer_*` / `mesh_interaction` / `camera_gesture` after
load), a `GET /api/v1/load-bounce` collector endpoint, an `api.loadBounce()` client
method, and a "Load → bounce funnel" dashboard panel. Derived from existing events —
no schema change.
