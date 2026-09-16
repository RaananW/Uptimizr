import type { Aabb, SceneRegion } from "@uptimizr/schema";
import type { SceneRegionRecord, SceneRegionSummary } from "../metadata.js";
import type { DuckdbClient } from "./client.js";

export type { SceneRegionRecord, SceneRegionSummary };

/**
 * Scene **regions** (ADR 0051 §2 / sketch §B.2) for the DuckDB single-file
 * store — the labelled-box vocabulary that extends the scene registry
 * (ADR 0014). One row per `(projectId, sceneId, regionId)`; regions may overlap.
 *
 * `bounds` is stored as JSON text (DuckDB has no JSONB) and parsed by the row
 * mapper; `updated_at` is read as epoch-ms and surfaced as a `Date`, matching
 * the scene-representation accessors so the store contract is identical across
 * engines.
 */

interface RegionRow {
  project_id: string;
  scene_id: string;
  region_id: string;
  label: string;
  description: string | null;
  bounds: string;
  updated_at_ms: number;
}

const SELECT_COLS = `project_id, scene_id, region_id, label, description, bounds,
       epoch_ms(updated_at) AS updated_at_ms`;

function rowToRegion(row: RegionRow): SceneRegionRecord {
  return {
    projectId: row.project_id,
    sceneId: row.scene_id,
    regionId: row.region_id,
    label: row.label,
    description: row.description,
    bounds: JSON.parse(row.bounds) as Aabb,
    updatedAt: new Date(row.updated_at_ms),
  };
}

/**
 * Replace the whole region set of `(projectId, sceneId)` with `regions` and
 * return the stored rows.
 *
 * Replace-the-set (rather than per-region upsert) keeps the authoring surface a
 * single idempotent `PUT`: the caller declares what the scene's regions *are*,
 * so removing a region is just leaving it out. The delete + insert runs inside
 * one DuckDB transaction on the exclusive connection, so a concurrent reader
 * never observes a half-replaced set (and a failed insert leaves the previous
 * set intact).
 */
export async function putSceneRegions(
  client: DuckdbClient,
  projectId: string,
  sceneId: string,
  regions: readonly SceneRegion[],
): Promise<SceneRegionRecord[]> {
  await client.exclusive(async (con) => {
    await con.run("BEGIN TRANSACTION");
    try {
      await con.run(
        `DELETE FROM scene_regions WHERE project_id = $projectId AND scene_id = $sceneId`,
        { projectId, sceneId },
      );
      for (const region of regions) {
        await con.run(
          `INSERT INTO scene_regions
             (project_id, scene_id, region_id, label, description, bounds, updated_at)
           VALUES ($projectId, $sceneId, $regionId, $label, $description, $bounds, now())`,
          {
            projectId,
            sceneId,
            regionId: region.id,
            label: region.label,
            description: region.description ?? null,
            bounds: JSON.stringify(region.bounds),
          },
        );
      }
      await con.run("COMMIT");
    } catch (err) {
      await con.run("ROLLBACK");
      throw err;
    }
  });
  return getSceneRegions(client, projectId, sceneId);
}

/** Read one scene's regions, ordered by region id (stable for callers/diffs). */
export async function getSceneRegions(
  client: DuckdbClient,
  projectId: string,
  sceneId: string,
): Promise<SceneRegionRecord[]> {
  const rows = await client.all<RegionRow>(
    `SELECT ${SELECT_COLS} FROM scene_regions
     WHERE project_id = $projectId AND scene_id = $sceneId
     ORDER BY region_id`,
    { projectId, sceneId },
  );
  return rows.map(rowToRegion);
}

/**
 * Project-wide region names (no boxes) — the whole spatial vocabulary in one
 * read, for a scene/region picker or an agent's project context.
 */
export async function listSceneRegions(
  client: DuckdbClient,
  projectId: string,
): Promise<SceneRegionSummary[]> {
  const rows = await client.all<Pick<RegionRow, "scene_id" | "region_id" | "label">>(
    `SELECT scene_id, region_id, label FROM scene_regions
     WHERE project_id = $projectId
     ORDER BY scene_id, region_id`,
    { projectId },
  );
  return rows.map((row) => ({
    sceneId: row.scene_id,
    regionId: row.region_id,
    label: row.label,
  }));
}
