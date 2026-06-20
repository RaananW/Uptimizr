import type { Aabb, SceneProxy } from "@uptimizr/schema";
import { toDuckdbTimestamp } from "../query/duckdbDialect.js";
import type {
  SceneRepresentation,
  SceneRepresentationKind,
  SceneRepresentationSummary,
} from "../metadata.js";
import type { DuckdbClient } from "./client.js";

export type { SceneRepresentation, SceneRepresentationKind, SceneRepresentationSummary };

/**
 * Spatial scene registry (ADR 0010 / 0014) for the DuckDB single-file store.
 * Mirrors the Postgres registry: one representation per `(projectId, sceneId)`.
 * `bounds`/`proxy` are stored as JSON text (DuckDB has no JSONB) and parsed by
 * the row mapper; timestamps are read as epoch-ms and surfaced as `Date`.
 */

interface SceneRow {
  project_id: string;
  scene_id: string;
  label: string | null;
  kind: string;
  up_axis: string;
  unit_scale: number;
  bounds: string | null;
  proxy: string | null;
  asset_url: string | null;
  content_hash: string | null;
  proxy_version: number | null;
  captured_at_ms: number | null;
  updated_at_ms: number;
}

function toKind(value: string): SceneRepresentationKind {
  return value === "proxy" || value === "asset" ? value : "none";
}

function toUpAxis(value: string): "y" | "z" {
  return value === "z" ? "z" : "y";
}

function parseJson<T>(value: string | null): T | null {
  if (value == null) return null;
  return JSON.parse(value) as T;
}

function rowToRepresentation(row: SceneRow): SceneRepresentation {
  return {
    projectId: row.project_id,
    sceneId: row.scene_id,
    label: row.label,
    kind: toKind(row.kind),
    upAxis: toUpAxis(row.up_axis),
    unitScale: Number(row.unit_scale),
    bounds: parseJson<Aabb>(row.bounds),
    proxy: parseJson<SceneProxy>(row.proxy),
    assetUrl: row.asset_url,
    contentHash: row.content_hash,
    proxyVersion: row.proxy_version === null ? null : Number(row.proxy_version),
    capturedAt: row.captured_at_ms === null ? null : new Date(row.captured_at_ms),
    updatedAt: new Date(row.updated_at_ms),
  };
}

const RETURNING = `RETURNING project_id, scene_id, label, kind, up_axis, unit_scale, bounds, proxy,
            asset_url, content_hash, proxy_version,
            epoch_ms(captured_at) AS captured_at_ms, epoch_ms(updated_at) AS updated_at_ms`;

/**
 * Insert or replace the scene proxy for `(projectId, proxy.sceneId)`. Stores the
 * full proxy as JSON text and promotes bounds/hash/version/captured-at to columns
 * for cheap listing. An optional `label` is merged in (kept if not provided).
 */
export async function upsertSceneProxy(
  client: DuckdbClient,
  projectId: string,
  proxy: SceneProxy,
  label?: string,
): Promise<SceneRepresentation> {
  const rows = await client.all<SceneRow>(
    `INSERT INTO scene_representations
       (project_id, scene_id, label, kind, up_axis, unit_scale, bounds, proxy,
        asset_url, content_hash, proxy_version, captured_at, updated_at)
     VALUES ($projectId, $sceneId, $label, 'proxy', $upAxis, $unitScale, $bounds, $proxy,
             NULL, $contentHash, $proxyVersion, $capturedAt::TIMESTAMP, now())
     ON CONFLICT (project_id, scene_id) DO UPDATE SET
       label         = COALESCE(EXCLUDED.label, scene_representations.label),
       kind          = 'proxy',
       up_axis       = EXCLUDED.up_axis,
       unit_scale    = EXCLUDED.unit_scale,
       bounds        = EXCLUDED.bounds,
       proxy         = EXCLUDED.proxy,
       asset_url     = NULL,
       content_hash  = EXCLUDED.content_hash,
       proxy_version = EXCLUDED.proxy_version,
       captured_at   = EXCLUDED.captured_at,
       updated_at    = now()
     ${RETURNING}`,
    {
      projectId,
      sceneId: proxy.sceneId,
      label: label ?? null,
      upAxis: proxy.upAxis,
      unitScale: proxy.unitScale,
      bounds: JSON.stringify(proxy.bounds),
      proxy: JSON.stringify(proxy),
      contentHash: proxy.contentHash,
      proxyVersion: proxy.version,
      capturedAt: toDuckdbTimestamp(proxy.capturedAt),
    },
  );
  return rowToRepresentation(rows[0]!);
}

/** Fetch one scene representation (including the proxy blob), or `null`. */
export async function getSceneRepresentation(
  client: DuckdbClient,
  projectId: string,
  sceneId: string,
): Promise<SceneRepresentation | null> {
  const rows = await client.all<SceneRow>(
    `SELECT project_id, scene_id, label, kind, up_axis, unit_scale, bounds, proxy,
            asset_url, content_hash, proxy_version,
            epoch_ms(captured_at) AS captured_at_ms, epoch_ms(updated_at) AS updated_at_ms
     FROM scene_representations
     WHERE project_id = $projectId AND scene_id = $sceneId`,
    { projectId, sceneId },
  );
  const row = rows[0];
  return row ? rowToRepresentation(row) : null;
}

/** List a project's scene representations (without proxy blobs), newest first. */
export async function listSceneRepresentations(
  client: DuckdbClient,
  projectId: string,
): Promise<SceneRepresentationSummary[]> {
  const rows = await client.all<Omit<SceneRow, "proxy" | "project_id">>(
    `SELECT scene_id, label, kind, up_axis, unit_scale, bounds, asset_url,
            content_hash, proxy_version,
            epoch_ms(captured_at) AS captured_at_ms, epoch_ms(updated_at) AS updated_at_ms
     FROM scene_representations
     WHERE project_id = $projectId
     ORDER BY updated_at DESC`,
    { projectId },
  );
  return rows.map((row) => ({
    sceneId: row.scene_id,
    label: row.label,
    kind: toKind(row.kind),
    bounds: parseJson<Aabb>(row.bounds),
    contentHash: row.content_hash,
    capturedAt: row.captured_at_ms === null ? null : new Date(row.captured_at_ms),
    updatedAt: new Date(row.updated_at_ms),
  }));
}
