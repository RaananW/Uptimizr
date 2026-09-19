import { randomUUID } from "node:crypto";
import {
  METADATA_LIMITS,
  MetadataLimitError,
  clampMetadataLimit,
  parsePanelSpec,
  toClickhouseTimestamp,
  type CreatePanelSpecInput,
  type MetadataAuthorKind,
  type MetadataListOptions,
  type PanelSpecRecord,
  type UpdatePanelSpecInput,
} from "@uptimizr/db";
import type { ClickhouseClient } from "./client.js";

/**
 * Declarative panel specs for the single-tenant ClickHouse store (#315,
 * ADR 0051 §7 / sketch §G.3).
 *
 * Semantics mirror the DuckDB accessors (same cap, same oldest-first ordering,
 * the same skipping of an unparseable row), but the mechanics follow this
 * engine: there is no row `UPDATE` and no `DELETE`, so the table is a
 * `ReplacingMergeTree` where an edit inserts a complete replacement row with a
 * newer `version` and an unpin inserts a `deleted = 1` tombstone. Every read is
 * `FINAL … WHERE deleted = 0`.
 */

/**
 * Strictly-increasing `ReplacingMergeTree` version. Epoch-ms alone is not
 * enough: two writes to the same row inside one millisecond would tie and
 * `FINAL` would pick between them arbitrarily — so an unpin could be undone by
 * the edit it followed. The counter keeps versions monotonic within the process
 * and still tracks wall-clock, so a later process outranks an earlier one.
 * (Same rule as `projectMetadata.ts`, kept local per table family.)
 */
let lastVersion = 0;
function nextVersion(): number {
  const now = Date.now();
  lastVersion = now > lastVersion ? now : lastVersion + 1;
  return lastVersion;
}

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
       toUnixTimestamp64Milli(created_at) AS created_at_ms,
       toUnixTimestamp64Milli(updated_at) AS updated_at_ms`;

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
  client: ClickhouseClient,
  sql: string,
  params: Record<string, unknown>,
): Promise<number> {
  const rows = await client.query<{ n: number | string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** The live row for `(projectId, id)`, or `undefined` when there is none. */
async function readOne(
  client: ClickhouseClient,
  projectId: string,
  id: string,
): Promise<PanelSpecRow | undefined> {
  const rows = await client.query<PanelSpecRow>(
    `SELECT ${PANEL_SPEC_COLS} FROM panel_specs FINAL
      WHERE project_id = {projectId:String} AND id = {id:String} AND deleted = 0`,
    { projectId, id },
  );
  return rows[0];
}

/** Pin one panel and return the stored row. */
export async function createPanelSpec(
  client: ClickhouseClient,
  projectId: string,
  input: CreatePanelSpecInput,
): Promise<PanelSpecRecord> {
  const count = await countRows(
    client,
    `SELECT count() AS n FROM panel_specs FINAL
      WHERE project_id = {projectId:String} AND deleted = 0`,
    { projectId },
  );
  if (count >= METADATA_LIMITS.panelSpecs) {
    throw new MetadataLimitError("panelSpecs", METADATA_LIMITS.panelSpecs);
  }
  const id = randomUUID();
  const now = Date.now();
  await client.insert("panel_specs", [
    {
      id,
      project_id: projectId,
      spec: JSON.stringify(input.spec),
      author_kind: input.authorKind,
      author_key_id: input.authorKeyId,
      created_at: toClickhouseTimestamp(now),
      updated_at: toClickhouseTimestamp(now),
      deleted: 0,
      version: nextVersion(),
    },
  ]);
  // Written from a document that serialized a line above, so the parse holds.
  return rowToPanelSpec((await readOne(client, projectId, id))!)!;
}

/** A project's pinned panels, oldest first — a pinned panel keeps its place. */
export async function listPanelSpecs(
  client: ClickhouseClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<PanelSpecRecord[]> {
  const limit = clampMetadataLimit(
    opts.limit,
    METADATA_LIMITS.panelSpecs,
    METADATA_LIMITS.panelSpecs,
  );
  const rows = await client.query<PanelSpecRow>(
    `SELECT ${PANEL_SPEC_COLS} FROM panel_specs FINAL
      WHERE project_id = {projectId:String} AND deleted = 0
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}`,
    { projectId },
  );
  return rows.map(rowToPanelSpec).filter((record): record is PanelSpecRecord => record !== null);
}

/**
 * Replace one panel's spec, keeping its id, its place and its original author.
 * `null` when the id is unknown or belongs to another project.
 *
 * A read-modify-write rather than a patch: the replacement row must carry every
 * column, so `created_at` and the authorship are read back and copied forward
 * unchanged. That is what keeps "who pinned this, and when did it appear" true
 * across an edit on this engine as much as on the others.
 */
export async function updatePanelSpec(
  client: ClickhouseClient,
  projectId: string,
  id: string,
  input: UpdatePanelSpecInput,
): Promise<PanelSpecRecord | null> {
  const existing = await readOne(client, projectId, id);
  if (existing == null) return null;
  await client.insert("panel_specs", [
    {
      id,
      project_id: projectId,
      spec: JSON.stringify(input.spec),
      author_kind: existing.author_kind,
      author_key_id: existing.author_key_id,
      created_at: toClickhouseTimestamp(Number(existing.created_at_ms)),
      updated_at: toClickhouseTimestamp(Date.now()),
      deleted: 0,
      version: nextVersion(),
    },
  ]);
  const updated = await readOne(client, projectId, id);
  return updated == null ? null : rowToPanelSpec(updated);
}

/** Unpin one panel: a tombstone row. Returns whether one was live to remove. */
export async function deletePanelSpec(
  client: ClickhouseClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const existing = await readOne(client, projectId, id);
  if (existing == null) return false;
  await client.insert("panel_specs", [
    {
      id,
      project_id: projectId,
      spec: "{}",
      author_kind: existing.author_kind,
      author_key_id: existing.author_key_id,
      created_at: toClickhouseTimestamp(Number(existing.created_at_ms)),
      updated_at: toClickhouseTimestamp(Date.now()),
      deleted: 1,
      version: nextVersion(),
    },
  ]);
  return true;
}
