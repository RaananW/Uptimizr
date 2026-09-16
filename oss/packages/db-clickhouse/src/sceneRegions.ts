import type { SceneRegionRecord, SceneRegionSummary } from "@uptimizr/db";
import { toClickhouseTimestamp } from "@uptimizr/db";
import type { Aabb, SceneRegion } from "@uptimizr/schema";
import type { ClickhouseClient } from "./client.js";

export type { SceneRegionRecord, SceneRegionSummary };

/**
 * Scene **regions** (ADR 0051 §2 / sketch §B.2) for the single-tenant ClickHouse
 * store — the labelled-box vocabulary that extends the scene registry
 * (ADR 0014). Mirrors the DuckDB / Postgres accessors: one row per
 * `(projectId, sceneId, regionId)`, `bounds` stored as JSON text and parsed by
 * the row mapper, `updated_at` read as epoch-ms and surfaced as a `Date`.
 *
 * ClickHouse has neither `DELETE` inside a transaction nor `ON CONFLICT`, so the
 * "replace the scene's set" write is expressed the `ReplacingMergeTree` way: one
 * atomic block insert carrying the new rows plus a `deleted = 1` tombstone for
 * every region id the new set drops, each stamped with a monotonic `version` so
 * the newest write wins. Reads take `FINAL` and filter `deleted = 0`.
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
       toUnixTimestamp64Milli(updated_at) AS updated_at_ms`;

/**
 * Strictly-increasing `ReplacingMergeTree` version. Epoch-ms alone is not enough:
 * two writes to the same scene inside one millisecond would tie, and `FINAL`
 * would pick between them arbitrarily — so a replace could resurrect a region it
 * had just dropped. The counter keeps versions monotonic within the process and
 * still tracks wall-clock, so a later process's writes outrank an earlier one's.
 */
let lastVersion = 0;
function nextVersion(): number {
  const now = Date.now();
  lastVersion = now > lastVersion ? now : lastVersion + 1;
  return lastVersion;
}

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
 * return the stored rows. New rows and the tombstones for dropped ids go in one
 * insert — a ClickHouse block insert is atomic, so a reader never sees a
 * half-replaced set.
 */
export async function putSceneRegions(
  client: ClickhouseClient,
  projectId: string,
  sceneId: string,
  regions: readonly SceneRegion[],
): Promise<SceneRegionRecord[]> {
  const existing = await client.query<{ region_id: string }>(
    `SELECT region_id FROM scene_regions FINAL
     WHERE project_id = {projectId:String} AND scene_id = {sceneId:String} AND deleted = 0`,
    { projectId, sceneId },
  );
  const keep = new Set(regions.map((r) => r.id));
  const dropped = existing.map((row) => row.region_id).filter((id) => !keep.has(id));

  const version = nextVersion();
  const stamp = toClickhouseTimestamp(Date.now());
  const rows = [
    ...regions.map((region) => ({
      project_id: projectId,
      scene_id: sceneId,
      region_id: region.id,
      label: region.label,
      description: region.description ?? null,
      bounds: JSON.stringify(region.bounds),
      updated_at: stamp,
      deleted: 0,
      version,
    })),
    ...dropped.map((regionId) => ({
      project_id: projectId,
      scene_id: sceneId,
      region_id: regionId,
      label: "",
      description: null,
      bounds: "[]",
      updated_at: stamp,
      deleted: 1,
      version,
    })),
  ];
  if (rows.length > 0) await client.insert("scene_regions", rows);

  return getSceneRegions(client, projectId, sceneId);
}

/** Read one scene's regions, ordered by region id (stable for callers/diffs). */
export async function getSceneRegions(
  client: ClickhouseClient,
  projectId: string,
  sceneId: string,
): Promise<SceneRegionRecord[]> {
  const rows = await client.query<RegionRow>(
    `SELECT ${SELECT_COLS} FROM scene_regions FINAL
     WHERE project_id = {projectId:String} AND scene_id = {sceneId:String} AND deleted = 0
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
  client: ClickhouseClient,
  projectId: string,
): Promise<SceneRegionSummary[]> {
  const rows = await client.query<Pick<RegionRow, "scene_id" | "region_id" | "label">>(
    `SELECT scene_id, region_id, label FROM scene_regions FINAL
     WHERE project_id = {projectId:String} AND deleted = 0
     ORDER BY scene_id, region_id`,
    { projectId },
  );
  return rows.map((row) => ({
    sceneId: row.scene_id,
    regionId: row.region_id,
    label: row.label,
  }));
}
