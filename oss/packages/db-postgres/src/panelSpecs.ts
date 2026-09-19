import { randomUUID } from "node:crypto";
import {
  METADATA_LIMITS,
  MetadataLimitError,
  clampMetadataLimit,
  parsePanelSpec,
  type CreatePanelSpecInput,
  type MetadataAuthorKind,
  type MetadataListOptions,
  type PanelSpecRecord,
  type UpdatePanelSpecInput,
} from "@uptimizr/db";
import type { PostgresClient } from "./client.js";

/**
 * Declarative panel specs for the single-tenant Postgres store (#315,
 * ADR 0051 §7 / sketch §G.3).
 *
 * Mirrors the DuckDB accessors row-for-row and semantics-for-semantics: the
 * same per-project cap, the same oldest-first ordering (these are grid
 * positions, not a feed), the same "an unparseable row is skipped rather than
 * fatal", and the same `MetadataLimitError` when a project is full — so the
 * collector behaves identically whichever engine is configured.
 */

/** `timestamp` → epoch milliseconds, the form the row mapper expects. */
const ms = (column: string): string => `(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`;

interface PanelSpecRow {
  id: string;
  project_id: string;
  spec: string;
  author_kind: string;
  author_key_id: string | null;
  created_at_ms: number | string;
  updated_at_ms: number | string;
}

const PANEL_SPEC_COLS = `id, project_id, spec, author_kind, author_key_id,
       ${ms("created_at")} AS created_at_ms, ${ms("updated_at")} AS updated_at_ms`;

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
  client: PostgresClient,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  const rows = await client.query<{ n: number | string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** Pin one panel and return the stored row. */
export async function createPanelSpec(
  client: PostgresClient,
  projectId: string,
  input: CreatePanelSpecInput,
): Promise<PanelSpecRecord> {
  const count = await countRows(
    client,
    `SELECT count(*) AS n FROM panel_specs WHERE project_id = $1`,
    [projectId],
  );
  if (count >= METADATA_LIMITS.panelSpecs) {
    throw new MetadataLimitError("panelSpecs", METADATA_LIMITS.panelSpecs);
  }
  const rows = await client.query<PanelSpecRow>(
    `INSERT INTO panel_specs
       (id, project_id, spec, author_kind, author_key_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, (now() AT TIME ZONE 'utc'), (now() AT TIME ZONE 'utc'))
     RETURNING ${PANEL_SPEC_COLS}`,
    [randomUUID(), projectId, JSON.stringify(input.spec), input.authorKind, input.authorKeyId],
  );
  // Written from a document that serialized a line above, so the parse holds.
  return rowToPanelSpec(rows[0]!)!;
}

/** A project's pinned panels, oldest first — a pinned panel keeps its place. */
export async function listPanelSpecs(
  client: PostgresClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<PanelSpecRecord[]> {
  const limit = clampMetadataLimit(
    opts.limit,
    METADATA_LIMITS.panelSpecs,
    METADATA_LIMITS.panelSpecs,
  );
  const rows = await client.query<PanelSpecRow>(
    `SELECT ${PANEL_SPEC_COLS} FROM panel_specs WHERE project_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}`,
    [projectId],
  );
  return rows.map(rowToPanelSpec).filter((record): record is PanelSpecRecord => record !== null);
}

/**
 * Replace one panel's spec, keeping its id, its place and its original author.
 * `null` when the id is unknown or belongs to another project.
 */
export async function updatePanelSpec(
  client: PostgresClient,
  projectId: string,
  id: string,
  input: UpdatePanelSpecInput,
): Promise<PanelSpecRecord | null> {
  const rows = await client.query<PanelSpecRow>(
    `UPDATE panel_specs SET spec = $3, updated_at = (now() AT TIME ZONE 'utc')
      WHERE project_id = $1 AND id = $2
      RETURNING ${PANEL_SPEC_COLS}`,
    [projectId, id, JSON.stringify(input.spec)],
  );
  const row = rows[0];
  return row == null ? null : rowToPanelSpec(row);
}

/** Unpin one panel. Returns whether a row was removed. */
export async function deletePanelSpec(
  client: PostgresClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const rows = await client.query<{ id: string }>(
    `DELETE FROM panel_specs WHERE project_id = $1 AND id = $2 RETURNING id`,
    [projectId, id],
  );
  return rows.length > 0;
}
