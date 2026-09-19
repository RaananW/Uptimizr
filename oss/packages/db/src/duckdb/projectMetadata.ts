import { randomUUID } from "node:crypto";
import {
  METADATA_LIMITS,
  MetadataLimitError,
  clampMetadataLimit,
  parseSavedAnalysisQuery,
  type AnnotationRecord,
  type AnnotationTargetKind,
  type CreateAnnotationInput,
  type CreateSavedAnalysisInput,
  type GlossaryEntryRecord,
  type ListAnnotationsOptions,
  type MetadataAuthorKind,
  type MetadataListOptions,
  type PutGlossaryEntryInput,
  type SavedAnalysisRecord,
} from "../metadata.js";
import type { DuckdbClient } from "./client.js";

/**
 * Project metadata — annotations, glossary, saved analyses — for the DuckDB
 * single-file store (ADR 0051 §5, sketch §E.2).
 *
 * These are the only rows a client can write besides events, and they are
 * written on a different path entirely: the `annotate` capability gates them,
 * every write is audited, and none of them touches the `events` table.
 *
 * Conventions follow the rest of this store: `TIMESTAMP` columns are read back
 * as epoch-ms and surfaced as `Date`s, JSON documents are stored as text and
 * parsed by the row mapper, and per-project caps are enforced here (rather than
 * in the route) so every engine and the CLI get the same bound.
 */

interface AnnotationRow {
  id: string;
  project_id: string;
  target_kind: string;
  target_id: string | null;
  since_ms: number | null;
  until_ms: number | null;
  text: string;
  author_kind: string;
  author_key_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

const ANNOTATION_COLS = `id, project_id, target_kind, target_id,
       epoch_ms(since) AS since_ms, epoch_ms(until) AS until_ms, text,
       author_kind, author_key_id,
       epoch_ms(created_at) AS created_at_ms, epoch_ms(updated_at) AS updated_at_ms`;

function toDate(ms: number | null): Date | null {
  return ms == null ? null : new Date(Number(ms));
}

function rowToAnnotation(row: AnnotationRow): AnnotationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    targetKind: row.target_kind as AnnotationTargetKind,
    targetId: row.target_id,
    since: toDate(row.since_ms),
    until: toDate(row.until_ms),
    text: row.text,
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

/**
 * Create one annotation and return the stored row.
 *
 * Refuses with {@link MetadataLimitError} once the project holds
 * {@link METADATA_LIMITS.annotations} rows: metadata is curated notes, not an
 * unbounded write surface, and refusing is more honest than evicting somebody
 * else's note.
 */
export async function createAnnotation(
  client: DuckdbClient,
  projectId: string,
  input: CreateAnnotationInput,
): Promise<AnnotationRecord> {
  const count = await countRows(
    client,
    `SELECT count(*) AS n FROM annotations WHERE project_id = $projectId`,
    { projectId },
  );
  if (count >= METADATA_LIMITS.annotations) {
    throw new MetadataLimitError("annotations", METADATA_LIMITS.annotations);
  }
  const { annotation } = input;
  const id = randomUUID();
  await client.run(
    `INSERT INTO annotations
       (id, project_id, target_kind, target_id, since, until, text,
        author_kind, author_key_id, created_at, updated_at)
     VALUES ($id, $projectId, $targetKind, $targetId,
             CASE WHEN $sinceUs IS NULL THEN NULL ELSE make_timestamp($sinceUs) END,
             CASE WHEN $untilUs IS NULL THEN NULL ELSE make_timestamp($untilUs) END,
             $text, $authorKind, $authorKeyId, now(), now())`,
    {
      id,
      projectId,
      targetKind: annotation.targetKind,
      targetId: annotation.targetId ?? null,
      sinceUs: annotation.since == null ? null : annotation.since * 1000,
      untilUs: annotation.until == null ? null : annotation.until * 1000,
      text: annotation.text,
      authorKind: input.authorKind,
      authorKeyId: input.authorKeyId,
    },
  );
  const rows = await client.all<AnnotationRow>(
    `SELECT ${ANNOTATION_COLS} FROM annotations WHERE id = $id`,
    { id },
  );
  // The row was just inserted on the same connection, so it is always there.
  return rowToAnnotation(rows[0]!);
}

/**
 * A project's annotations, newest first.
 *
 * The optional `since`/`until` bounds are an **overlap** filter, not a
 * containment one: an annotation matches when its period intersects the
 * requested window, and a standing note (no period at all) always matches
 * because it is about the project rather than about a moment.
 */
export async function listAnnotations(
  client: DuckdbClient,
  projectId: string,
  opts: ListAnnotationsOptions = {},
): Promise<AnnotationRecord[]> {
  const limit = clampMetadataLimit(opts.limit);
  const params: Record<string, unknown> = { projectId };
  const where = ["project_id = $projectId"];
  if (opts.targetKind != null) {
    where.push("target_kind = $targetKind");
    params.targetKind = opts.targetKind;
  }
  if (opts.targetId != null) {
    where.push("target_id = $targetId");
    params.targetId = opts.targetId;
  }
  if (opts.since != null) {
    where.push("(until IS NULL OR until >= make_timestamp($since))");
    params.since = Math.trunc(opts.since) * 1000;
  }
  if (opts.until != null) {
    where.push("(since IS NULL OR since < make_timestamp($until))");
    params.until = Math.trunc(opts.until) * 1000;
  }
  const rows = await client.all<AnnotationRow>(
    `SELECT ${ANNOTATION_COLS}
       FROM annotations
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(rowToAnnotation);
}

/**
 * Delete one annotation of this project. Returns whether a row was removed, so
 * the route can answer 404 for an id that is not there (or belongs to another
 * project — the two are indistinguishable to the caller, deliberately).
 */
export async function deleteAnnotation(
  client: DuckdbClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const before = await countRows(
    client,
    `SELECT count(*) AS n FROM annotations WHERE project_id = $projectId AND id = $id`,
    { projectId, id },
  );
  if (before === 0) return false;
  await client.run(`DELETE FROM annotations WHERE project_id = $projectId AND id = $id`, {
    projectId,
    id,
  });
  return true;
}

interface GlossaryRow {
  project_id: string;
  term: string;
  meaning: string;
  updated_at_ms: number;
}

function rowToGlossaryEntry(row: GlossaryRow): GlossaryEntryRecord {
  return {
    projectId: row.project_id,
    term: row.term,
    meaning: row.meaning,
    updatedAt: new Date(Number(row.updated_at_ms)),
  };
}

/**
 * Upsert one glossary entry and return the stored row. Idempotent: the term is
 * the identity, so re-defining it replaces the meaning instead of accumulating
 * duplicates. The per-project cap applies only when a *new* term is added.
 */
export async function putGlossaryEntry(
  client: DuckdbClient,
  projectId: string,
  input: PutGlossaryEntryInput,
): Promise<GlossaryEntryRecord> {
  const { term, meaning } = input.entry;
  const existing = await countRows(
    client,
    `SELECT count(*) AS n FROM glossary WHERE project_id = $projectId AND term = $term`,
    { projectId, term },
  );
  if (existing === 0) {
    const count = await countRows(
      client,
      `SELECT count(*) AS n FROM glossary WHERE project_id = $projectId`,
      { projectId },
    );
    if (count >= METADATA_LIMITS.glossary) {
      throw new MetadataLimitError("glossary", METADATA_LIMITS.glossary);
    }
  }
  await client.run(
    `INSERT INTO glossary (project_id, term, meaning, updated_at)
     VALUES ($projectId, $term, $meaning, now())
     ON CONFLICT (project_id, term)
     DO UPDATE SET meaning = EXCLUDED.meaning, updated_at = now()`,
    { projectId, term, meaning },
  );
  const rows = await client.all<GlossaryRow>(
    `SELECT project_id, term, meaning, epoch_ms(updated_at) AS updated_at_ms
       FROM glossary WHERE project_id = $projectId AND term = $term`,
    { projectId, term },
  );
  return rowToGlossaryEntry(rows[0]!);
}

/** A project's whole glossary, ordered by term (stable for diffs and prompts). */
export async function listGlossary(
  client: DuckdbClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<GlossaryEntryRecord[]> {
  const limit = clampMetadataLimit(opts.limit, METADATA_LIMITS.glossary, METADATA_LIMITS.glossary);
  const rows = await client.all<GlossaryRow>(
    `SELECT project_id, term, meaning, epoch_ms(updated_at) AS updated_at_ms
       FROM glossary WHERE project_id = $projectId
      ORDER BY term
      LIMIT ${limit}`,
    { projectId },
  );
  return rows.map(rowToGlossaryEntry);
}

/** Delete one term. Returns whether it existed. */
export async function deleteGlossaryEntry(
  client: DuckdbClient,
  projectId: string,
  term: string,
): Promise<boolean> {
  const before = await countRows(
    client,
    `SELECT count(*) AS n FROM glossary WHERE project_id = $projectId AND term = $term`,
    { projectId, term },
  );
  if (before === 0) return false;
  await client.run(`DELETE FROM glossary WHERE project_id = $projectId AND term = $term`, {
    projectId,
    term,
  });
  return true;
}

interface SavedAnalysisRow {
  id: string;
  project_id: string;
  title: string;
  query: string;
  conclusion: string | null;
  author_kind: string;
  author_key_id: string | null;
  created_at_ms: number;
}

const ANALYSIS_COLS = `id, project_id, title, query, conclusion, author_kind, author_key_id,
       epoch_ms(created_at) AS created_at_ms`;

function rowToSavedAnalysis(row: SavedAnalysisRow): SavedAnalysisRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    query: parseSavedAnalysisQuery(row.query),
    conclusion: row.conclusion,
    authorKind: row.author_kind as MetadataAuthorKind,
    authorKeyId: row.author_key_id,
    createdAt: new Date(Number(row.created_at_ms)),
  };
}

/** Create one saved analysis and return the stored row. */
export async function createSavedAnalysis(
  client: DuckdbClient,
  projectId: string,
  input: CreateSavedAnalysisInput,
): Promise<SavedAnalysisRecord> {
  const count = await countRows(
    client,
    `SELECT count(*) AS n FROM saved_analyses WHERE project_id = $projectId`,
    { projectId },
  );
  if (count >= METADATA_LIMITS.savedAnalyses) {
    throw new MetadataLimitError("savedAnalyses", METADATA_LIMITS.savedAnalyses);
  }
  const { analysis } = input;
  const id = randomUUID();
  await client.run(
    `INSERT INTO saved_analyses
       (id, project_id, title, query, conclusion, author_kind, author_key_id, created_at)
     VALUES ($id, $projectId, $title, $query, $conclusion, $authorKind, $authorKeyId, now())`,
    {
      id,
      projectId,
      title: analysis.title,
      query: JSON.stringify(analysis.query),
      conclusion: analysis.conclusion ?? null,
      authorKind: input.authorKind,
      authorKeyId: input.authorKeyId,
    },
  );
  const rows = await client.all<SavedAnalysisRow>(
    `SELECT ${ANALYSIS_COLS} FROM saved_analyses WHERE id = $id`,
    { id },
  );
  return rowToSavedAnalysis(rows[0]!);
}

/** A project's saved analyses, newest first. */
export async function listSavedAnalyses(
  client: DuckdbClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<SavedAnalysisRecord[]> {
  const limit = clampMetadataLimit(opts.limit);
  const rows = await client.all<SavedAnalysisRow>(
    `SELECT ${ANALYSIS_COLS}
       FROM saved_analyses WHERE project_id = $projectId
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}`,
    { projectId },
  );
  return rows.map(rowToSavedAnalysis);
}

/** Delete one saved analysis. Returns whether it existed. */
export async function deleteSavedAnalysis(
  client: DuckdbClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const before = await countRows(
    client,
    `SELECT count(*) AS n FROM saved_analyses WHERE project_id = $projectId AND id = $id`,
    { projectId, id },
  );
  if (before === 0) return false;
  await client.run(`DELETE FROM saved_analyses WHERE project_id = $projectId AND id = $id`, {
    projectId,
    id,
  });
  return true;
}
