import { randomUUID } from "node:crypto";
import {
  METADATA_LIMITS,
  MetadataLimitError,
  clampMetadataLimit,
  mssqlDialect,
  parsePanelSpec,
  type CreatePanelSpecInput,
  type MetadataAuthorKind,
  type MetadataListOptions,
  type PanelSpecRecord,
  type UpdatePanelSpecInput,
} from "@uptimizr/db";
import type { MssqlClient } from "./client.js";

/**
 * Declarative panel specs for the single-tenant SQL Server store (#315,
 * ADR 0051 §7 / sketch §G.3).
 *
 * Mirrors the DuckDB accessors row-for-row: the same per-project cap, the same
 * oldest-first ordering (these are grid positions, not a feed), the same
 * "an unparseable row is skipped rather than fatal", and the same
 * `MetadataLimitError` when a project is full.
 */

interface PanelSpecRow {
  id: string;
  project_id: string;
  spec: string;
  author_kind: string;
  author_key_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

const PANEL_SPEC_COLS = `id, project_id, spec, author_kind, author_key_id,
       ${mssqlDialect.epochMs("created_at")} AS created_at_ms,
       ${mssqlDialect.epochMs("updated_at")} AS updated_at_ms`;

/** Map one row, or `null` when its `spec` column is not a JSON object. */
function rowToPanelSpec(row: PanelSpecRow): PanelSpecRecord | null {
  const spec = parsePanelSpec(row.spec);
  if (spec == null) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    spec,
    authorKind: row.author_kind as MetadataAuthorKind,
    authorKeyId: row.author_key_id,
    createdAt: new Date(Number(row.created_at_ms)),
    updatedAt: new Date(Number(row.updated_at_ms)),
  };
}

async function countRows(
  client: MssqlClient,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  const rows = await client.query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** Pin one panel and return the stored row. */
export async function createPanelSpec(
  client: MssqlClient,
  projectId: string,
  input: CreatePanelSpecInput,
): Promise<PanelSpecRecord> {
  const count = await countRows(
    client,
    `SELECT count(*) AS n FROM dbo.panel_specs WHERE project_id = @p1`,
    [projectId],
  );
  if (count >= METADATA_LIMITS.panelSpecs) {
    throw new MetadataLimitError("panelSpecs", METADATA_LIMITS.panelSpecs);
  }
  const id = randomUUID();
  await client.query(
    `INSERT INTO dbo.panel_specs
       (id, project_id, spec, author_kind, author_key_id, created_at, updated_at)
     VALUES (@p1, @p2, @p3, @p4, @p5, SYSUTCDATETIME(), SYSUTCDATETIME())`,
    [id, projectId, JSON.stringify(input.spec), input.authorKind, input.authorKeyId],
  );
  const rows = await client.query<PanelSpecRow>(
    `SELECT ${PANEL_SPEC_COLS} FROM dbo.panel_specs WHERE id = @p1`,
    [id],
  );
  // Written from a document that serialized a line above, so the parse holds.
  return rowToPanelSpec(rows[0]!)!;
}

/** A project's pinned panels, oldest first — a pinned panel keeps its place. */
export async function listPanelSpecs(
  client: MssqlClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<PanelSpecRecord[]> {
  const limit = clampMetadataLimit(
    opts.limit,
    METADATA_LIMITS.panelSpecs,
    METADATA_LIMITS.panelSpecs,
  );
  const rows = await client.query<PanelSpecRow>(
    `SELECT TOP (${limit}) ${PANEL_SPEC_COLS} FROM dbo.panel_specs
      WHERE project_id = @p1 ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(rowToPanelSpec).filter((record): record is PanelSpecRecord => record !== null);
}

/**
 * Replace one panel's spec, keeping its id, its place and its original author.
 * `null` when the id is unknown or belongs to another project.
 */
export async function updatePanelSpec(
  client: MssqlClient,
  projectId: string,
  id: string,
  input: UpdatePanelSpecInput,
): Promise<PanelSpecRecord | null> {
  const existing = await countRows(
    client,
    `SELECT count(*) AS n FROM dbo.panel_specs WHERE project_id = @p1 AND id = @p2`,
    [projectId, id],
  );
  if (existing === 0) return null;
  await client.query(
    `UPDATE dbo.panel_specs SET spec = @p3, updated_at = SYSUTCDATETIME()
      WHERE project_id = @p1 AND id = @p2`,
    [projectId, id, JSON.stringify(input.spec)],
  );
  const rows = await client.query<PanelSpecRow>(
    `SELECT ${PANEL_SPEC_COLS} FROM dbo.panel_specs WHERE id = @p1`,
    [id],
  );
  const row = rows[0];
  return row == null ? null : rowToPanelSpec(row);
}

/** Unpin one panel. Returns whether a row was removed. */
export async function deletePanelSpec(
  client: MssqlClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const before = await countRows(
    client,
    `SELECT count(*) AS n FROM dbo.panel_specs WHERE project_id = @p1 AND id = @p2`,
    [projectId, id],
  );
  if (before === 0) return false;
  await client.query(`DELETE FROM dbo.panel_specs WHERE project_id = @p1 AND id = @p2`, [
    projectId,
    id,
  ]);
  return true;
}
