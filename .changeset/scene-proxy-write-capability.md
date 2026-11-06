---
"@uptimizr/collector-server": minor
---

`PUT /api/v1/scenes/:sceneId/representation` now requires the `annotate` capability instead of `query`, matching scene regions, so a read-only key cannot replace a scene's proxy geometry. Owner keys and the keys `pnpm db:seed` mints already hold `annotate`. A key minted with `uptimizr new-key` and only `query` now gets a `403` on upload; mint one with `--capabilities query,annotate`.
