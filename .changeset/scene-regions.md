---
"@uptimizr/collector-server": minor
"@uptimizr/db-clickhouse": minor
"@uptimizr/db-postgres": minor
"@uptimizr/db-mssql": minor
"@uptimizr/sdk-core": minor
"@uptimizr/schema": minor
"@uptimizr/db": minor
---

Add **scene regions** — named, labelled world-space boxes that give a scene a shared vocabulary
for _where_ things happen ("the entrance", "the checkout counter").

- `@uptimizr/schema`: `sceneRegionSchema` / `sceneRegionsSchema` (config, deliberately outside the
  event union) plus the `maxSceneRegionLabelLength` / `maxSceneRegionDescriptionLength` /
  `maxSceneRegions` bounds.
- `@uptimizr/db` and the optional Postgres / SQL Server / ClickHouse stores: a `scene_regions`
  metadata table (forward-only, idempotent migration) keyed `(project_id, scene_id, region_id)`,
  with `putSceneRegions` (replaces a scene's whole set atomically), `getSceneRegions` and
  `listSceneRegions`.
- `@uptimizr/collector-server`: `PUT` / `GET /api/v1/scenes/:sceneId/regions`, the project-wide
  `GET /api/v1/scene-regions` listing, `uptimizr regions set|get` CLI commands, and `region=<id>`
  as an alternative to the six-number box on every spatial endpoint that already takes a region
  (resolved server-side to the stored bounds; an unregistered id is a `400`). Region authoring
  accepts a `query`-capable key for now — an interim until the `annotate` capability lands.
- `@uptimizr/sdk-core`: `registerRegions(sceneId, regions, { endpoint, apiKey })`, the authoring
  counterpart to a connector's `scanSceneProxy`.
