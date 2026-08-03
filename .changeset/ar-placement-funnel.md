---
"@uptimizr/schema": minor
"@uptimizr/babylon": minor
"@uptimizr/db": minor
"@uptimizr/react": minor
---

Add the `ar_placement` event and AR placement funnel analytics (#156, ADR 0048).

- **schema:** new source-neutral `ar_placement` event, emitted once per placement
  "settle" for retail "view in your room" AR — `mesh`, final world `position`, coarse
  `surface` (`floor`/`wall`/`table`/`ceiling`/`unknown`), `attempts`, `timeToPlaceMs`,
  `scale`, and `final`. Reuses the promoted `mesh`/`position` columns, so no DB
  migration.
- **@uptimizr/babylon:** `babylonArPlacementCollector` captures WebXR hit-test/anchor
  placement and enqueues one `ar_placement` per settle, classifying the surface coarsely
  from the hit normal (`classifyArSurface`). Coarse, on-device-only signals (ADR 0003).
- **@uptimizr/db:** dialect-agnostic `buildArPlacementTimeToPlace`,
  `buildArPlacementAttempts`, and `buildArPlacementSurfaces` builders for the placement
  funnel (time-to-place distribution, re-placement count, surface breakdown), with parity
  cases.
- **@uptimizr/react:** `arPlacementTimeToPlace` / `arPlacementAttempts` /
  `arPlacementSurfaces` API methods and an **AR placement funnel** dashboard panel.
