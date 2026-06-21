import type {
  SceneRepresentation,
  SceneRepresentationKind,
  SceneRepresentationSummary,
} from "@uptimizr/db";
import { toClickhouseTimestamp } from "@uptimizr/db";
import type { Aabb, SceneProxy } from "@uptimizr/schema";
import type { ClickhouseClient } from "./client.js";

export type { SceneRepresentation, SceneRepresentationKind, SceneRepresentationSummary };

/**
 * Spatial scene registry (ADR 0010 / 0014) for the single-tenant ClickHouse
 * store. Mirrors the DuckDB / Postgres registry: one representation per
 * `(projectId, sceneId)`, stored in a `ReplacingMergeTree` so the latest upsert
 * (highest `version`) wins and reads use `FINAL`. `bounds`/`proxy` are stored as
 * JSON text and parsed by the row mapper; timestamps are read as epoch-ms and
 * surfaced as `Date`.
 *
 * ClickHouse has no `ON CONFLICT`, so the "keep the existing label when none is
 * supplied" merge is done read-modify-write here before inserting the new row.
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
       toUnixTimestamp64Milli(captured_at) AS captured_at_ms,
       toUnixTimestamp64Milli(updated_at) AS updated_at_ms`;

/**
 * Insert or replace the scene proxy for `(projectId, proxy.sceneId)`. Stores the
 * full proxy as JSON text and promotes bounds/hash/version/captured-at to columns
 * for cheap listing. An optional `label` is merged in (kept if not provided),
 * read-modify-write since ClickHouse has no upsert.
 */
export async function upsertSceneProxy(
  client: ClickhouseClient,
  projectId: string,
  proxy: SceneProxy,
  label?: string,
): Promise<SceneRepresentation> {
  let effectiveLabel: string | null = label ?? null;
  if (effectiveLabel == null) {
    const existing = await client.query<{ label: string | null }>(
      `SELECT label FROM scene_representations FINAL
       WHERE project_id = {projectId:String} AND scene_id = {sceneId:String}`,
      { projectId, sceneId: proxy.sceneId },
    );
    effectiveLabel = existing[0]?.label ?? null;
  }

  await client.insert("scene_representations", [
    {
      project_id: projectId,
      scene_id: proxy.sceneId,
      label: effectiveLabel,
      kind: "proxy",
      up_axis: proxy.upAxis,
      unit_scale: proxy.unitScale,
      bounds: JSON.stringify(proxy.bounds),
      proxy: JSON.stringify(proxy),
      asset_url: null,
      content_hash: proxy.contentHash,
      proxy_version: proxy.version,
      captured_at: toClickhouseTimestamp(proxy.capturedAt),
      updated_at: toClickhouseTimestamp(Date.now()),
      version: Date.now(),
    },
  ]);

  const rows = await client.query<SceneRow>(
    `SELECT ${SELECT_COLS} FROM scene_representations FINAL
     WHERE project_id = {projectId:String} AND scene_id = {sceneId:String}`,
    { projectId, sceneId: proxy.sceneId },
  );
  return rowToRepresentation(rows[0]!);
}

/** Fetch one scene representation (including the proxy blob), or `null`. */
export async function getSceneRepresentation(
  client: ClickhouseClient,
  projectId: string,
  sceneId: string,
): Promise<SceneRepresentation | null> {
  const rows = await client.query<SceneRow>(
    `SELECT ${SELECT_COLS} FROM scene_representations FINAL
     WHERE project_id = {projectId:String} AND scene_id = {sceneId:String}`,
    { projectId, sceneId },
  );
  const row = rows[0];
  return row ? rowToRepresentation(row) : null;
}

/** List a project's scene representations (without proxy blobs), newest first. */
export async function listSceneRepresentations(
  client: ClickhouseClient,
  projectId: string,
): Promise<SceneRepresentationSummary[]> {
  const rows = await client.query<Omit<SceneRow, "proxy" | "project_id">>(
    `SELECT scene_id, label, kind, up_axis, unit_scale, bounds, asset_url,
            content_hash, proxy_version,
            toUnixTimestamp64Milli(captured_at) AS captured_at_ms,
            toUnixTimestamp64Milli(updated_at) AS updated_at_ms
     FROM scene_representations FINAL
     WHERE project_id = {projectId:String}
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
