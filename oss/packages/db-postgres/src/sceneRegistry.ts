import type {
  SceneRepresentation,
  SceneRepresentationKind,
  SceneRepresentationSummary,
} from "@uptimizr/db";
import { toPostgresTimestamp } from "@uptimizr/db";
import type { Aabb, SceneProxy } from "@uptimizr/schema";
import type { PostgresClient } from "./client.js";

export type { SceneRepresentation, SceneRepresentationKind, SceneRepresentationSummary };

/**
 * Spatial scene registry (ADR 0010 / 0014) for the single-tenant Postgres
 * store. Mirrors the DuckDB registry: one representation per
 * `(projectId, sceneId)`, upserted with a native `ON CONFLICT … DO UPDATE`.
 * `bounds`/`proxy` are stored as JSON text and parsed by the row mapper;
 * timestamps are read as epoch-ms and surfaced as `Date`.
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

const SELECT_COLS = `project_id, scene_id, label, kind, up_axis, unit_scale, bounds, proxy,
       asset_url, content_hash, proxy_version,
       (EXTRACT(EPOCH FROM captured_at) * 1000)::bigint AS captured_at_ms,
       (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms`;

/**
 * Insert or replace the scene proxy for `(projectId, proxy.sceneId)`. Stores the
 * full proxy as JSON text and promotes bounds/hash/version/captured-at to columns
 * for cheap listing. An optional `label` is merged in (kept if not provided).
 */
export async function upsertSceneProxy(
  client: PostgresClient,
  projectId: string,
  proxy: SceneProxy,
  label?: string,
): Promise<SceneRepresentation> {
  const rows = await client.query<SceneRow>(
    `INSERT INTO scene_representations
       (project_id, scene_id, label, kind, up_axis, unit_scale, bounds, proxy,
        asset_url, content_hash, proxy_version, captured_at, updated_at)
     VALUES ($1, $2, $3, 'proxy', $4, $5, $6, $7,
             NULL, $8, $9, $10::timestamp, (now() AT TIME ZONE 'utc'))
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
       updated_at    = (now() AT TIME ZONE 'utc')
     RETURNING ${SELECT_COLS}`,
    [
      projectId,
      proxy.sceneId,
      label ?? null,
      proxy.upAxis,
      proxy.unitScale,
      JSON.stringify(proxy.bounds),
      JSON.stringify(proxy),
      proxy.contentHash,
      proxy.version,
      toPostgresTimestamp(proxy.capturedAt),
    ],
  );
  return rowToRepresentation(rows[0]!);
}

/** Fetch one scene representation (including the proxy blob), or `null`. */
export async function getSceneRepresentation(
  client: PostgresClient,
  projectId: string,
  sceneId: string,
): Promise<SceneRepresentation | null> {
  const rows = await client.query<SceneRow>(
    `SELECT ${SELECT_COLS} FROM scene_representations
     WHERE project_id = $1 AND scene_id = $2`,
    [projectId, sceneId],
  );
  const row = rows[0];
  return row ? rowToRepresentation(row) : null;
}

/** List a project's scene representations (without proxy blobs), newest first. */
export async function listSceneRepresentations(
  client: PostgresClient,
  projectId: string,
): Promise<SceneRepresentationSummary[]> {
  const rows = await client.query<Omit<SceneRow, "proxy" | "project_id">>(
    `SELECT scene_id, label, kind, up_axis, unit_scale, bounds, asset_url,
            content_hash, proxy_version,
            (EXTRACT(EPOCH FROM captured_at) * 1000)::bigint AS captured_at_ms,
            (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms
     FROM scene_representations
     WHERE project_id = $1
     ORDER BY updated_at DESC`,
    [projectId],
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
