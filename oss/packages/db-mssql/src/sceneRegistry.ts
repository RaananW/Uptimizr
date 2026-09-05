import type {
  SceneRepresentation,
  SceneRepresentationKind,
  SceneRepresentationSummary,
} from "@uptimizr/db";
import { mssqlDialect, toMssqlTimestamp } from "@uptimizr/db";
import type { Aabb, SceneProxy } from "@uptimizr/schema";
import type { MssqlClient } from "./client.js";

export type { SceneRepresentation, SceneRepresentationKind, SceneRepresentationSummary };

/**
 * Spatial scene registry (ADR 0010 / 0014) for the single-tenant SQL Server
 * store. Mirrors the DuckDB registry: one representation per
 * `(projectId, sceneId)`, upserted with a `MERGE … WITH (HOLDLOCK)` (the T-SQL
 * equivalent of `ON CONFLICT … DO UPDATE`). `bounds`/`proxy` are stored as JSON
 * text and parsed by the row mapper; timestamps are read as epoch-ms and
 * surfaced as `Date`.
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

const EPOCH_MS = (col: string) => mssqlDialect.epochMs(col);

const SELECT_COLS = `project_id, scene_id, label, kind, up_axis, unit_scale, bounds, proxy,
       asset_url, content_hash, proxy_version,
       ${EPOCH_MS("captured_at")} AS captured_at_ms,
       ${EPOCH_MS("updated_at")} AS updated_at_ms`;

/**
 * Insert or replace the scene proxy for `(projectId, proxy.sceneId)`. Stores the
 * full proxy as JSON text and promotes bounds/hash/version/captured-at to columns
 * for cheap listing. An optional `label` is merged in (kept if not provided).
 */
export async function upsertSceneProxy(
  client: MssqlClient,
  projectId: string,
  proxy: SceneProxy,
  label?: string,
): Promise<SceneRepresentation> {
  const params = [
    projectId,
    proxy.sceneId,
    label ?? null,
    proxy.upAxis,
    proxy.unitScale,
    JSON.stringify(proxy.bounds),
    JSON.stringify(proxy),
    proxy.contentHash,
    proxy.version,
    toMssqlTimestamp(proxy.capturedAt),
  ];
  return client.transaction(async (tx) => {
    await tx.query(
      `MERGE dbo.scene_representations WITH (HOLDLOCK) AS t
       USING (SELECT @p1 AS project_id, @p2 AS scene_id) AS s
         ON t.project_id = s.project_id AND t.scene_id = s.scene_id
       WHEN MATCHED THEN UPDATE SET
         label         = COALESCE(@p3, t.label),
         kind          = N'proxy',
         up_axis       = @p4,
         unit_scale    = @p5,
         bounds        = @p6,
         proxy         = @p7,
         asset_url     = NULL,
         content_hash  = @p8,
         proxy_version = @p9,
         captured_at   = CAST(@p10 AS datetime2(3)),
         updated_at    = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT
         (project_id, scene_id, label, kind, up_axis, unit_scale, bounds, proxy,
          asset_url, content_hash, proxy_version, captured_at, updated_at)
         VALUES (@p1, @p2, @p3, N'proxy', @p4, @p5, @p6, @p7,
                 NULL, @p8, @p9, CAST(@p10 AS datetime2(3)), SYSUTCDATETIME());`,
      params,
    );
    const rows = await tx.query<SceneRow>(
      `SELECT ${SELECT_COLS} FROM dbo.scene_representations
       WHERE project_id = @p1 AND scene_id = @p2`,
      [projectId, proxy.sceneId],
    );
    return rowToRepresentation(rows[0]!);
  });
}

/** Fetch one scene representation (including the proxy blob), or `null`. */
export async function getSceneRepresentation(
  client: MssqlClient,
  projectId: string,
  sceneId: string,
): Promise<SceneRepresentation | null> {
  const rows = await client.query<SceneRow>(
    `SELECT ${SELECT_COLS} FROM dbo.scene_representations
     WHERE project_id = @p1 AND scene_id = @p2`,
    [projectId, sceneId],
  );
  const row = rows[0];
  return row ? rowToRepresentation(row) : null;
}

/** List a project's scene representations (without proxy blobs), newest first. */
export async function listSceneRepresentations(
  client: MssqlClient,
  projectId: string,
): Promise<SceneRepresentationSummary[]> {
  const rows = await client.query<Omit<SceneRow, "proxy" | "project_id">>(
    `SELECT scene_id, label, kind, up_axis, unit_scale, bounds, asset_url,
            content_hash, proxy_version,
            ${EPOCH_MS("captured_at")} AS captured_at_ms,
            ${EPOCH_MS("updated_at")} AS updated_at_ms
     FROM dbo.scene_representations
     WHERE project_id = @p1
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
