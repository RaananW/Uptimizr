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
} from "../metadata.js";
import type { DuckdbClient } from "./client.js";

/**
 * Declarative panel specs for the DuckDB single-file store (#315, ADR 0051 §7,
 * sketch §G.3).
 *
 * A fourth metadata table alongside annotations, the glossary and saved
 * analyses, written on the same `annotate`-gated, audited path and bounded the
 * same way. It differs from the other three in exactly one respect — a spec can
 * be **updated in place**, because a pinned panel has a position in somebody's
 * grid that retitling it should not cost.
 *
 * Conventions follow the rest of this store: `TIMESTAMP` columns are read back
 * as epoch-ms and surfaced as `Date`s, the JSON document is stored as text and
 * parsed by the row mapper, and the per-project cap is enforced here rather
 * than in the route so every engine and the CLI get the same bound.
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
       epoch_ms(created_at) AS created_at_ms, epoch_ms(updated_at) AS updated_at_ms`;

/**
 * Map one row, or `null` when its `spec` column is not a JSON object.
 *
 * A row that cannot be parsed cannot be drawn, and a listing that threw on one
 * would take the whole dashboard grid down with it. Dropping it is the same
 * choice ADR 0041's remote-panel loader makes for a module that fails to
 * import: one bad entry never blocks the rest.
 */
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

/** `SELECT count(*)` as a plain number, whatever width the driver returns. */
async function countRows(
  client: DuckdbClient,
  sql: string,
  params: Record<string, unknown>,
): Promise<number> {
  const rows = await client.all<{ n: number | bigint }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** Read one row back by id, for the create/update paths. */
async function readOne(client: DuckdbClient, id: string): Promise<PanelSpecRecord> {
  const rows = await client.all<PanelSpecRow>(
    `SELECT ${PANEL_SPEC_COLS} FROM panel_specs WHERE id = $id`,
    { id },
  );
  // Written on this connection a moment ago, from a document that serialized,
  // so both the row and its parse are guaranteed here.
  return rowToPanelSpec(rows[0]!)!;
}

/**
 * Pin one panel and return the stored row.
 *
 * Refuses with {@link MetadataLimitError} once the project holds
 * {@link METADATA_LIMITS.panelSpecs} panels. The cap is lower than the other
 * metadata tables' on purpose: every spec is a query the dashboard runs on
 * every load, so the bound is about what a grid can usefully hold.
 */
export async function createPanelSpec(
  client: DuckdbClient,
  projectId: string,
  input: CreatePanelSpecInput,
): Promise<PanelSpecRecord> {
  const count = await countRows(
    client,
    `SELECT count(*) AS n FROM panel_specs WHERE project_id = $projectId`,
    { projectId },
  );
  if (count >= METADATA_LIMITS.panelSpecs) {
    throw new MetadataLimitError("panelSpecs", METADATA_LIMITS.panelSpecs);
  }
  const id = randomUUID();
  await client.run(
    `INSERT INTO panel_specs
       (id, project_id, spec, author_kind, author_key_id, created_at, updated_at)
     VALUES ($id, $projectId, $spec, $authorKind, $authorKeyId, now(), now())`,
    {
      id,
      projectId,
      spec: JSON.stringify(input.spec),
      authorKind: input.authorKind,
      authorKeyId: input.authorKeyId,
    },
  );
  return readOne(client, id);
}

/**
 * A project's pinned panels, **oldest first**.
 *
 * The opposite order to the other metadata listings, and deliberately so: these
 * are grid positions, not a feed. Newest-first would move every panel down the
 * dashboard each time somebody pinned one, which is exactly the instability a
 * person notices and a saved layout cannot survive.
 */
export async function listPanelSpecs(
  client: DuckdbClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<PanelSpecRecord[]> {
  const limit = clampMetadataLimit(
    opts.limit,
    METADATA_LIMITS.panelSpecs,
    METADATA_LIMITS.panelSpecs,
  );
  const rows = await client.all<PanelSpecRow>(
    `SELECT ${PANEL_SPEC_COLS}
       FROM panel_specs WHERE project_id = $projectId
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}`,
    { projectId },
  );
  return rows.map(rowToPanelSpec).filter((record): record is PanelSpecRecord => record !== null);
}

/**
 * Replace one panel's spec, keeping its id, its place in the grid and its
 * original authorship. Returns `null` when the id is unknown (or belongs to
 * another project — the two are deliberately indistinguishable).
 */
export async function updatePanelSpec(
  client: DuckdbClient,
  projectId: string,
  id: string,
  input: UpdatePanelSpecInput,
): Promise<PanelSpecRecord | null> {
  const before = await countRows(
    client,
    `SELECT count(*) AS n FROM panel_specs WHERE project_id = $projectId AND id = $id`,
    { projectId, id },
  );
  if (before === 0) return null;
  await client.run(
    `UPDATE panel_specs SET spec = $spec, updated_at = now()
      WHERE project_id = $projectId AND id = $id`,
    { projectId, id, spec: JSON.stringify(input.spec) },
  );
  return readOne(client, id);
}

/** Unpin one panel. Returns whether a row was removed. */
export async function deletePanelSpec(
  client: DuckdbClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const before = await countRows(
    client,
    `SELECT count(*) AS n FROM panel_specs WHERE project_id = $projectId AND id = $id`,
    { projectId, id },
  );
  if (before === 0) return false;
  await client.run(`DELETE FROM panel_specs WHERE project_id = $projectId AND id = $id`, {
    projectId,
    id,
  });
  return true;
}
