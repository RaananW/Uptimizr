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
} from "@uptimizr/db";
import type { PostgresClient } from "./client.js";

/**
 * Project metadata — annotations, glossary, saved analyses — for the
 * single-tenant Postgres store (ADR 0051 §5 / sketch §E.2).
 *
 * Mirrors the DuckDB accessors row-for-row and semantics-for-semantics: the
 * same per-project caps, the same "newest first" ordering, the same overlap
 * filter, and the same `MetadataLimitError` when a project is full, so the
 * collector behaves identically whichever engine is configured.
 */

/** `timestamp` → epoch milliseconds, the form the row mappers expect. */
const ms = (column: string): string => `(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`;

/** Epoch milliseconds → a naive-UTC `timestamp`, matching every other write. */
const toTimestamp = (placeholder: string): string =>
  `to_timestamp(${placeholder}::double precision / 1000) AT TIME ZONE 'utc'`;

interface AnnotationRow {
  id: string;
  project_id: string;
  target_kind: string;
  target_id: string | null;
  since_ms: number | string | null;
  until_ms: number | string | null;
  text: string;
  author_kind: string;
  author_key_id: string | null;
  created_at_ms: number | string;
  updated_at_ms: number | string;
}

const ANNOTATION_COLS = `id, project_id, target_kind, target_id,
       ${ms("since")} AS since_ms, ${ms("until")} AS until_ms, text,
       author_kind, author_key_id,
       ${ms("created_at")} AS created_at_ms, ${ms("updated_at")} AS updated_at_ms`;

function toDate(value: number | string | null): Date | null {
  return value == null ? null : new Date(Number(value));
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

async function countRows(
  client: PostgresClient,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  const rows = await client.query<{ n: number | string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** Create one annotation and return the stored row. */
export async function createAnnotation(
  client: PostgresClient,
  projectId: string,
  input: CreateAnnotationInput,
): Promise<AnnotationRecord> {
  const count = await countRows(
    client,
    `SELECT count(*) AS n FROM annotations WHERE project_id = $1`,
    [projectId],
  );
  if (count >= METADATA_LIMITS.annotations) {
    throw new MetadataLimitError("annotations", METADATA_LIMITS.annotations);
  }
  const { annotation } = input;
  const rows = await client.query<AnnotationRow>(
    `INSERT INTO annotations
       (id, project_id, target_kind, target_id, since, until, text,
        author_kind, author_key_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4,
             -- to_timestamp(NULL) is NULL, so a standing note needs no branch.
             ${toTimestamp("$5")}, ${toTimestamp("$6")},
             $7, $8, $9, (now() AT TIME ZONE 'utc'), (now() AT TIME ZONE 'utc'))
     RETURNING ${ANNOTATION_COLS}`,
    [
      randomUUID(),
      projectId,
      annotation.targetKind,
      annotation.targetId ?? null,
      annotation.since ?? null,
      annotation.until ?? null,
      annotation.text,
      input.authorKind,
      input.authorKeyId,
    ],
  );
  return rowToAnnotation(rows[0]!);
}

/** A project's annotations, newest first, optionally filtered by target/overlap. */
export async function listAnnotations(
  client: PostgresClient,
  projectId: string,
  opts: ListAnnotationsOptions = {},
): Promise<AnnotationRecord[]> {
  const limit = clampMetadataLimit(opts.limit);
  const params: unknown[] = [projectId];
  const where = ["project_id = $1"];
  if (opts.targetKind != null) {
    params.push(opts.targetKind);
    where.push(`target_kind = $${params.length}`);
  }
  if (opts.targetId != null) {
    params.push(opts.targetId);
    where.push(`target_id = $${params.length}`);
  }
  if (opts.since != null) {
    params.push(opts.since);
    where.push(`(until IS NULL OR until >= ${toTimestamp(`$${params.length}`)})`);
  }
  if (opts.until != null) {
    params.push(opts.until);
    where.push(`(since IS NULL OR since < ${toTimestamp(`$${params.length}`)})`);
  }
  const rows = await client.query<AnnotationRow>(
    `SELECT ${ANNOTATION_COLS} FROM annotations
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(rowToAnnotation);
}

/** Delete one annotation of this project. Returns whether a row was removed. */
export async function deleteAnnotation(
  client: PostgresClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const rows = await client.query<{ id: string }>(
    `DELETE FROM annotations WHERE project_id = $1 AND id = $2 RETURNING id`,
    [projectId, id],
  );
  return rows.length > 0;
}

interface GlossaryRow {
  project_id: string;
  term: string;
  meaning: string;
  updated_at_ms: number | string;
}

const GLOSSARY_COLS = `project_id, term, meaning, ${ms("updated_at")} AS updated_at_ms`;

function rowToGlossaryEntry(row: GlossaryRow): GlossaryEntryRecord {
  return {
    projectId: row.project_id,
    term: row.term,
    meaning: row.meaning,
    updatedAt: new Date(Number(row.updated_at_ms)),
  };
}

/** Upsert one glossary entry (the term is the identity) and return the row. */
export async function putGlossaryEntry(
  client: PostgresClient,
  projectId: string,
  input: PutGlossaryEntryInput,
): Promise<GlossaryEntryRecord> {
  const { term, meaning } = input.entry;
  const existing = await countRows(
    client,
    `SELECT count(*) AS n FROM glossary WHERE project_id = $1 AND term = $2`,
    [projectId, term],
  );
  if (existing === 0) {
    const count = await countRows(
      client,
      `SELECT count(*) AS n FROM glossary WHERE project_id = $1`,
      [projectId],
    );
    if (count >= METADATA_LIMITS.glossary) {
      throw new MetadataLimitError("glossary", METADATA_LIMITS.glossary);
    }
  }
  const rows = await client.query<GlossaryRow>(
    `INSERT INTO glossary (project_id, term, meaning, updated_at)
     VALUES ($1, $2, $3, (now() AT TIME ZONE 'utc'))
     ON CONFLICT (project_id, term)
     DO UPDATE SET meaning = EXCLUDED.meaning, updated_at = (now() AT TIME ZONE 'utc')
     RETURNING ${GLOSSARY_COLS}`,
    [projectId, term, meaning],
  );
  return rowToGlossaryEntry(rows[0]!);
}

/** A project's whole glossary, ordered by term. */
export async function listGlossary(
  client: PostgresClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<GlossaryEntryRecord[]> {
  const limit = clampMetadataLimit(opts.limit, METADATA_LIMITS.glossary, METADATA_LIMITS.glossary);
  const rows = await client.query<GlossaryRow>(
    `SELECT ${GLOSSARY_COLS} FROM glossary WHERE project_id = $1 ORDER BY term LIMIT ${limit}`,
    [projectId],
  );
  return rows.map(rowToGlossaryEntry);
}

/** Delete one term. Returns whether it existed. */
export async function deleteGlossaryEntry(
  client: PostgresClient,
  projectId: string,
  term: string,
): Promise<boolean> {
  const rows = await client.query<{ term: string }>(
    `DELETE FROM glossary WHERE project_id = $1 AND term = $2 RETURNING term`,
    [projectId, term],
  );
  return rows.length > 0;
}

interface SavedAnalysisRow {
  id: string;
  project_id: string;
  title: string;
  query: string;
  conclusion: string | null;
  author_kind: string;
  author_key_id: string | null;
  created_at_ms: number | string;
}

const ANALYSIS_COLS = `id, project_id, title, query, conclusion, author_kind, author_key_id,
       ${ms("created_at")} AS created_at_ms`;

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
  client: PostgresClient,
  projectId: string,
  input: CreateSavedAnalysisInput,
): Promise<SavedAnalysisRecord> {
  const count = await countRows(
    client,
    `SELECT count(*) AS n FROM saved_analyses WHERE project_id = $1`,
    [projectId],
  );
  if (count >= METADATA_LIMITS.savedAnalyses) {
    throw new MetadataLimitError("savedAnalyses", METADATA_LIMITS.savedAnalyses);
  }
  const { analysis } = input;
  const rows = await client.query<SavedAnalysisRow>(
    `INSERT INTO saved_analyses
       (id, project_id, title, query, conclusion, author_kind, author_key_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, (now() AT TIME ZONE 'utc'))
     RETURNING ${ANALYSIS_COLS}`,
    [
      randomUUID(),
      projectId,
      analysis.title,
      JSON.stringify(analysis.query),
      analysis.conclusion ?? null,
      input.authorKind,
      input.authorKeyId,
    ],
  );
  return rowToSavedAnalysis(rows[0]!);
}

/** A project's saved analyses, newest first. */
export async function listSavedAnalyses(
  client: PostgresClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<SavedAnalysisRecord[]> {
  const limit = clampMetadataLimit(opts.limit);
  const rows = await client.query<SavedAnalysisRow>(
    `SELECT ${ANALYSIS_COLS} FROM saved_analyses WHERE project_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}`,
    [projectId],
  );
  return rows.map(rowToSavedAnalysis);
}

/** Delete one saved analysis. Returns whether it existed. */
export async function deleteSavedAnalysis(
  client: PostgresClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const rows = await client.query<{ id: string }>(
    `DELETE FROM saved_analyses WHERE project_id = $1 AND id = $2 RETURNING id`,
    [projectId, id],
  );
  return rows.length > 0;
}
