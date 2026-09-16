import type { SceneRegionRecord, SceneRegionSummary } from "@uptimizr/db";
import type { Aabb, SceneRegion } from "@uptimizr/schema";
import type { PostgresClient, PostgresExecutor } from "./client.js";

export type { SceneRegionRecord, SceneRegionSummary };

/**
 * Scene **regions** (ADR 0051 §2 / sketch §B.2) for the single-tenant Postgres
 * store — the labelled-box vocabulary that extends the scene registry
 * (ADR 0014). Mirrors the DuckDB accessors: one row per
 * `(projectId, sceneId, regionId)`, `bounds` stored as JSON text and parsed by
 * the row mapper, `updated_at` read as epoch-ms and surfaced as a `Date`.
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
       (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms`;

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

async function selectRegions(
  executor: PostgresExecutor,
  projectId: string,
  sceneId: string,
): Promise<SceneRegionRecord[]> {
  const rows = await executor.query<RegionRow>(
    `SELECT ${SELECT_COLS} FROM scene_regions
     WHERE project_id = $1 AND scene_id = $2
     ORDER BY region_id`,
    [projectId, sceneId],
  );
  return rows.map(rowToRegion);
}

/**
 * Replace the whole region set of `(projectId, sceneId)` with `regions` and
 * return the stored rows. The delete + inserts run in one transaction, so a
 * concurrent reader never sees a half-replaced set.
 */
export async function putSceneRegions(
  client: PostgresClient,
  projectId: string,
  sceneId: string,
  regions: readonly SceneRegion[],
): Promise<SceneRegionRecord[]> {
  return client.transaction(async (tx) => {
    await tx.query(`DELETE FROM scene_regions WHERE project_id = $1 AND scene_id = $2`, [
      projectId,
      sceneId,
    ]);
    for (const region of regions) {
      await tx.query(
        `INSERT INTO scene_regions
           (project_id, scene_id, region_id, label, description, bounds, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, (now() AT TIME ZONE 'utc'))`,
        [
          projectId,
          sceneId,
          region.id,
          region.label,
          region.description ?? null,
          JSON.stringify(region.bounds),
        ],
      );
    }
    return selectRegions(tx, projectId, sceneId);
  });
}

/** Read one scene's regions, ordered by region id (stable for callers/diffs). */
export async function getSceneRegions(
  client: PostgresClient,
  projectId: string,
  sceneId: string,
): Promise<SceneRegionRecord[]> {
  return selectRegions(client, projectId, sceneId);
}

/**
 * Project-wide region names (no boxes) — the whole spatial vocabulary in one
 * read, for a scene/region picker or an agent's project context.
 */
export async function listSceneRegions(
  client: PostgresClient,
  projectId: string,
): Promise<SceneRegionSummary[]> {
  const rows = await client.query<Pick<RegionRow, "scene_id" | "region_id" | "label">>(
    `SELECT scene_id, region_id, label FROM scene_regions
     WHERE project_id = $1
     ORDER BY scene_id, region_id`,
    [projectId],
  );
  return rows.map((row) => ({
    sceneId: row.scene_id,
    regionId: row.region_id,
    label: row.label,
  }));
}
