import { randomUUID } from "node:crypto";
import {
  METADATA_LIMITS,
  MetadataLimitError,
  clampMetadataLimit,
  mssqlDialect,
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
import type { MssqlClient } from "./client.js";

/**
 * Project metadata — annotations, glossary, saved analyses — for the
 * single-tenant SQL Server store (ADR 0051 §5 / sketch §E.2).
 *
 * Mirrors the DuckDB accessors row-for-row: the same per-project caps, the same
 * "newest first" ordering, the same overlap filter and the same
 * `MetadataLimitError`. `text` is a T-SQL data-type name, so the annotation
 * column is bracketed throughout.
 */

/**
 * Epoch-ms → `datetime2(3)`. `DATEADD(millisecond, …)` overflows `int` for an
 * absolute epoch, so the value is split into whole seconds plus a millisecond
 * remainder — both well inside `int` — and added in two steps. (Same helper as
 * `audit.ts`; kept local so neither file owns the other's SQL.)
 */
function epochToDatetime(param: string): string {
  return `DATEADD(millisecond, ${param} % 1000, DATEADD(second, ${param} / 1000, CAST(N'1970-01-01' AS datetime2(3))))`;
}

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
       ${mssqlDialect.epochMs("since")} AS since_ms,
       ${mssqlDialect.epochMs("until")} AS until_ms,
       [text], author_kind, author_key_id,
       ${mssqlDialect.epochMs("created_at")} AS created_at_ms,
       ${mssqlDialect.epochMs("updated_at")} AS updated_at_ms`;

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

async function countRows(
  client: MssqlClient,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  const rows = await client.query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** Create one annotation and return the stored row. */
export async function createAnnotation(
  client: MssqlClient,
  projectId: string,
  input: CreateAnnotationInput,
): Promise<AnnotationRecord> {
  const count = await countRows(
    client,
    `SELECT count(*) AS n FROM dbo.annotations WHERE project_id = @p1`,
    [projectId],
  );
  if (count >= METADATA_LIMITS.annotations) {
    throw new MetadataLimitError("annotations", METADATA_LIMITS.annotations);
  }
  const { annotation } = input;
  const id = randomUUID();
  await client.query(
    `INSERT INTO dbo.annotations
       (id, project_id, target_kind, target_id, since, until, [text],
        author_kind, author_key_id, created_at, updated_at)
     VALUES (@p1, @p2, @p3, @p4,
             CASE WHEN @p5 IS NULL THEN NULL ELSE ${epochToDatetime("@p5")} END,
             CASE WHEN @p6 IS NULL THEN NULL ELSE ${epochToDatetime("@p6")} END,
             @p7, @p8, @p9, SYSUTCDATETIME(), SYSUTCDATETIME())`,
    [
      id,
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
  const rows = await client.query<AnnotationRow>(
    `SELECT ${ANNOTATION_COLS} FROM dbo.annotations WHERE id = @p1`,
    [id],
  );
  return rowToAnnotation(rows[0]!);
}

/** A project's annotations, newest first, optionally filtered by target/overlap. */
export async function listAnnotations(
  client: MssqlClient,
  projectId: string,
  opts: ListAnnotationsOptions = {},
): Promise<AnnotationRecord[]> {
  const limit = clampMetadataLimit(opts.limit);
  const params: unknown[] = [projectId];
  const where = ["project_id = @p1"];
  if (opts.targetKind != null) {
    params.push(opts.targetKind);
    where.push(`target_kind = @p${params.length}`);
  }
  if (opts.targetId != null) {
    params.push(opts.targetId);
    where.push(`target_id = @p${params.length}`);
  }
  if (opts.since != null) {
    params.push(Math.trunc(opts.since));
    where.push(`(until IS NULL OR until >= ${epochToDatetime(`@p${params.length}`)})`);
  }
  if (opts.until != null) {
    params.push(Math.trunc(opts.until));
    where.push(`(since IS NULL OR since < ${epochToDatetime(`@p${params.length}`)})`);
  }
  const rows = await client.query<AnnotationRow>(
    `SELECT TOP (${limit}) ${ANNOTATION_COLS}
       FROM dbo.annotations
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC`,
    params,
  );
  return rows.map(rowToAnnotation);
}

/** Delete one annotation of this project. Returns whether a row was removed. */
export async function deleteAnnotation(
  client: MssqlClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const rows = await client.query<{ id: string }>(
    `DELETE FROM dbo.annotations OUTPUT DELETED.id AS id WHERE project_id = @p1 AND id = @p2`,
    [projectId, id],
  );
  return rows.length > 0;
}

interface GlossaryRow {
  project_id: string;
  term: string;
  meaning: string;
  updated_at_ms: number;
}

const GLOSSARY_COLS = `project_id, term, meaning,
       ${mssqlDialect.epochMs("updated_at")} AS updated_at_ms`;

function rowToGlossaryEntry(row: GlossaryRow): GlossaryEntryRecord {
  return {
    projectId: row.project_id,
    term: row.term,
    meaning: row.meaning,
    updatedAt: new Date(Number(row.updated_at_ms)),
  };
}

/**
 * Upsert one glossary entry (the term is the identity) and return the row.
 *
 * `UPDATE`-then-`INSERT` rather than `MERGE`: SQL Server's `MERGE` has enough
 * well-known correctness footguns under concurrency that the two-statement form
 * is the safer default, and this write is not hot.
 */
export async function putGlossaryEntry(
  client: MssqlClient,
  projectId: string,
  input: PutGlossaryEntryInput,
): Promise<GlossaryEntryRecord> {
  const { term, meaning } = input.entry;
  const existing = await countRows(
    client,
    `SELECT count(*) AS n FROM dbo.glossary WHERE project_id = @p1 AND term = @p2`,
    [projectId, term],
  );
  if (existing === 0) {
    const count = await countRows(
      client,
      `SELECT count(*) AS n FROM dbo.glossary WHERE project_id = @p1`,
      [projectId],
    );
    if (count >= METADATA_LIMITS.glossary) {
      throw new MetadataLimitError("glossary", METADATA_LIMITS.glossary);
    }
    await client.query(
      `INSERT INTO dbo.glossary (project_id, term, meaning, updated_at)
       VALUES (@p1, @p2, @p3, SYSUTCDATETIME())`,
      [projectId, term, meaning],
    );
  } else {
    await client.query(
      `UPDATE dbo.glossary SET meaning = @p3, updated_at = SYSUTCDATETIME()
        WHERE project_id = @p1 AND term = @p2`,
      [projectId, term, meaning],
    );
  }
  const rows = await client.query<GlossaryRow>(
    `SELECT ${GLOSSARY_COLS} FROM dbo.glossary WHERE project_id = @p1 AND term = @p2`,
    [projectId, term],
  );
  return rowToGlossaryEntry(rows[0]!);
}

/** A project's whole glossary, ordered by term. */
export async function listGlossary(
  client: MssqlClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<GlossaryEntryRecord[]> {
  const limit = clampMetadataLimit(opts.limit, METADATA_LIMITS.glossary, METADATA_LIMITS.glossary);
  const rows = await client.query<GlossaryRow>(
    `SELECT TOP (${limit}) ${GLOSSARY_COLS} FROM dbo.glossary
      WHERE project_id = @p1 ORDER BY term`,
    [projectId],
  );
  return rows.map(rowToGlossaryEntry);
}

/** Delete one term. Returns whether it existed. */
export async function deleteGlossaryEntry(
  client: MssqlClient,
  projectId: string,
  term: string,
): Promise<boolean> {
  const rows = await client.query<{ term: string }>(
    `DELETE FROM dbo.glossary OUTPUT DELETED.term AS term WHERE project_id = @p1 AND term = @p2`,
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
  created_at_ms: number;
}

const ANALYSIS_COLS = `id, project_id, title, query, conclusion, author_kind, author_key_id,
       ${mssqlDialect.epochMs("created_at")} AS created_at_ms`;

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
  client: MssqlClient,
  projectId: string,
  input: CreateSavedAnalysisInput,
): Promise<SavedAnalysisRecord> {
  const count = await countRows(
    client,
    `SELECT count(*) AS n FROM dbo.saved_analyses WHERE project_id = @p1`,
    [projectId],
  );
  if (count >= METADATA_LIMITS.savedAnalyses) {
    throw new MetadataLimitError("savedAnalyses", METADATA_LIMITS.savedAnalyses);
  }
  const { analysis } = input;
  const id = randomUUID();
  await client.query(
    `INSERT INTO dbo.saved_analyses
       (id, project_id, title, query, conclusion, author_kind, author_key_id, created_at)
     VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, SYSUTCDATETIME())`,
    [
      id,
      projectId,
      analysis.title,
      JSON.stringify(analysis.query),
      analysis.conclusion ?? null,
      input.authorKind,
      input.authorKeyId,
    ],
  );
  const rows = await client.query<SavedAnalysisRow>(
    `SELECT ${ANALYSIS_COLS} FROM dbo.saved_analyses WHERE id = @p1`,
    [id],
  );
  return rowToSavedAnalysis(rows[0]!);
}

/** A project's saved analyses, newest first. */
export async function listSavedAnalyses(
  client: MssqlClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<SavedAnalysisRecord[]> {
  const limit = clampMetadataLimit(opts.limit);
  const rows = await client.query<SavedAnalysisRow>(
    `SELECT TOP (${limit}) ${ANALYSIS_COLS} FROM dbo.saved_analyses
      WHERE project_id = @p1 ORDER BY created_at DESC, id DESC`,
    [projectId],
  );
  return rows.map(rowToSavedAnalysis);
}

/** Delete one saved analysis. Returns whether it existed. */
export async function deleteSavedAnalysis(
  client: MssqlClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const rows = await client.query<{ id: string }>(
    `DELETE FROM dbo.saved_analyses OUTPUT DELETED.id AS id WHERE project_id = @p1 AND id = @p2`,
    [projectId, id],
  );
  return rows.length > 0;
}
