---
"@uptimizr/schema": minor
"@uptimizr/sdk-core": minor
"@uptimizr/babylon": minor
"@uptimizr/db": minor
"@uptimizr/react": minor
---

feat: optional `position` on `runtime_error` / `graphics_diagnostic` + spatial error heatmap (#154)

Add an optional, best-effort `position` (`[x, y, z]`, the camera pose at the moment the event
fired) to the `runtime_error` and `graphics_diagnostic` events. The Babylon connector stamps it
automatically from the tracked camera; `sdk-core` gains a `setPositionProvider` seam so any connector
can supply one, and enrichment happens centrally in `emitInternal` (before `beforeSend`, so it stays
redactable). The field is additive and backward-compatible — older events simply omit it, and it
reuses the already-promoted `position` column (no migration).

On the read side, `@uptimizr/db` adds `buildErrorHeatmap` (voxel-bins positioned errors +
diagnostics, with optional `severity`/`category`/`errorKind` filters), surfaced via the collector's
new `GET /api/v1/heatmaps/errors` endpoint and a new **Error heatmap (3D)** dashboard panel
(`@uptimizr/react`) reusing the world-heatmap view — revealing _where_ in the scene things break,
not just _when_.
