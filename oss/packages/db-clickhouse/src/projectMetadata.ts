import { randomUUID } from "node:crypto";
import {
  METADATA_LIMITS,
  MetadataLimitError,
  clampMetadataLimit,
  parseSavedAnalysisQuery,
  toClickhouseTimestamp,
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
import type { ClickhouseClient } from "./client.js";

/**
 * Project metadata — annotations, glossary, saved analyses — for the
 * single-tenant ClickHouse store (ADR 0051 §5 / sketch §E.2).
 *
 * Semantics mirror the DuckDB accessors (same caps, same ordering, same overlap
 * filter, same `MetadataLimitError`), but the mechanics follow this engine:
 * there is no row `DELETE` and no `ON CONFLICT`, so each table is a
 * `ReplacingMergeTree` where an update inserts a newer `version` and a delete
 * inserts a `deleted = 1` tombstone, exactly as `scene_regions` does. Every read
 * is `FINAL … WHERE deleted = 0`.
 */

/**
 * Strictly-increasing `ReplacingMergeTree` version. Epoch-ms alone is not
 * enough: two writes to the same row inside one millisecond would tie and
 * `FINAL` would pick between them arbitrarily — so a delete could be undone by
 * the update it followed. The counter keeps versions monotonic within the
 * process and still tracks wall-clock, so a later process outranks an earlier
 * one. (Same rule as `sceneRegions.ts`, kept local per table family.)
 */
let lastVersion = 0;
function nextVersion(): number {
  const now = Date.now();
  lastVersion = now > lastVersion ? now : lastVersion + 1;
  return lastVersion;
}

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
       toUnixTimestamp64Milli(since) AS since_ms,
       toUnixTimestamp64Milli(until) AS until_ms,
       text, author_kind, author_key_id,
       toUnixTimestamp64Milli(created_at) AS created_at_ms,
       toUnixTimestamp64Milli(updated_at) AS updated_at_ms`;

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
  client: ClickhouseClient,
  sql: string,
  params: Record<string, unknown>,
): Promise<number> {
  const rows = await client.query<{ n: number | string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** Create one annotation and return the stored row. */
export async function createAnnotation(
  client: ClickhouseClient,
  projectId: string,
  input: CreateAnnotationInput,
): Promise<AnnotationRecord> {
  const count = await countRows(
    client,
    `SELECT count() AS n FROM annotations FINAL
      WHERE project_id = {projectId:String} AND deleted = 0`,
    { projectId },
  );
  if (count >= METADATA_LIMITS.annotations) {
    throw new MetadataLimitError("annotations", METADATA_LIMITS.annotations);
  }
  const { annotation } = input;
  const id = randomUUID();
  const stamp = toClickhouseTimestamp(Date.now());
  await client.insert("annotations", [
    {
      id,
      project_id: projectId,
      target_kind: annotation.targetKind,
      target_id: annotation.targetId ?? null,
      since: annotation.since == null ? null : toClickhouseTimestamp(annotation.since),
      until: annotation.until == null ? null : toClickhouseTimestamp(annotation.until),
      text: annotation.text,
      author_kind: input.authorKind,
      author_key_id: input.authorKeyId,
      created_at: stamp,
      updated_at: stamp,
      deleted: 0,
      version: nextVersion(),
    },
  ]);
  const rows = await client.query<AnnotationRow>(
    `SELECT ${ANNOTATION_COLS} FROM annotations FINAL
      WHERE project_id = {projectId:String} AND id = {id:String} AND deleted = 0`,
    { projectId, id },
  );
  return rowToAnnotation(rows[0]!);
}

/** A project's annotations, newest first, optionally filtered by target/overlap. */
export async function listAnnotations(
  client: ClickhouseClient,
  projectId: string,
  opts: ListAnnotationsOptions = {},
): Promise<AnnotationRecord[]> {
  const limit = clampMetadataLimit(opts.limit);
  const params: Record<string, unknown> = { projectId };
  const where = ["project_id = {projectId:String}", "deleted = 0"];
  if (opts.targetKind != null) {
    where.push("target_kind = {targetKind:String}");
    params.targetKind = opts.targetKind;
  }
  if (opts.targetId != null) {
    where.push("target_id = {targetId:String}");
    params.targetId = opts.targetId;
  }
  if (opts.since != null) {
    where.push("(until IS NULL OR until >= {since:DateTime64(3)})");
    params.since = toClickhouseTimestamp(Math.trunc(opts.since));
  }
  if (opts.until != null) {
    where.push("(since IS NULL OR since < {until:DateTime64(3)})");
    params.until = toClickhouseTimestamp(Math.trunc(opts.until));
  }
  const rows = await client.query<AnnotationRow>(
    `SELECT ${ANNOTATION_COLS} FROM annotations FINAL
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(rowToAnnotation);
}

/**
 * Delete one annotation by inserting a tombstone with a newer version. Returns
 * whether the row existed, so the route can still answer 404 for an unknown id.
 */
export async function deleteAnnotation(
  client: ClickhouseClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const existing = await client.query<AnnotationRow>(
    `SELECT ${ANNOTATION_COLS} FROM annotations FINAL
      WHERE project_id = {projectId:String} AND id = {id:String} AND deleted = 0`,
    { projectId, id },
  );
  if (existing.length === 0) return false;
  await client.insert("annotations", [
    {
      id,
      project_id: projectId,
      target_kind: "",
      target_id: null,
      since: null,
      until: null,
      text: "",
      author_kind: "user",
      author_key_id: null,
      created_at: toClickhouseTimestamp(Date.now()),
      updated_at: toClickhouseTimestamp(Date.now()),
      deleted: 1,
      version: nextVersion(),
    },
  ]);
  return true;
}

interface GlossaryRow {
  project_id: string;
  term: string;
  meaning: string;
  updated_at_ms: number | string;
}

const GLOSSARY_COLS = `project_id, term, meaning,
       toUnixTimestamp64Milli(updated_at) AS updated_at_ms`;

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
  client: ClickhouseClient,
  projectId: string,
  input: PutGlossaryEntryInput,
): Promise<GlossaryEntryRecord> {
  const { term, meaning } = input.entry;
  const existing = await countRows(
    client,
    `SELECT count() AS n FROM glossary FINAL
      WHERE project_id = {projectId:String} AND term = {term:String} AND deleted = 0`,
    { projectId, term },
  );
  if (existing === 0) {
    const count = await countRows(
      client,
      `SELECT count() AS n FROM glossary FINAL
        WHERE project_id = {projectId:String} AND deleted = 0`,
      { projectId },
    );
    if (count >= METADATA_LIMITS.glossary) {
      throw new MetadataLimitError("glossary", METADATA_LIMITS.glossary);
    }
  }
  await client.insert("glossary", [
    {
      project_id: projectId,
      term,
      meaning,
      updated_at: toClickhouseTimestamp(Date.now()),
      deleted: 0,
      version: nextVersion(),
    },
  ]);
  const rows = await client.query<GlossaryRow>(
    `SELECT ${GLOSSARY_COLS} FROM glossary FINAL
      WHERE project_id = {projectId:String} AND term = {term:String} AND deleted = 0`,
    { projectId, term },
  );
  return rowToGlossaryEntry(rows[0]!);
}

/** A project's whole glossary, ordered by term. */
export async function listGlossary(
  client: ClickhouseClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<GlossaryEntryRecord[]> {
  const limit = clampMetadataLimit(opts.limit, METADATA_LIMITS.glossary, METADATA_LIMITS.glossary);
  const rows = await client.query<GlossaryRow>(
    `SELECT ${GLOSSARY_COLS} FROM glossary FINAL
      WHERE project_id = {projectId:String} AND deleted = 0
      ORDER BY term
      LIMIT ${limit}`,
    { projectId },
  );
  return rows.map(rowToGlossaryEntry);
}

/** Delete one term by inserting a tombstone. Returns whether it existed. */
export async function deleteGlossaryEntry(
  client: ClickhouseClient,
  projectId: string,
  term: string,
): Promise<boolean> {
  const existing = await countRows(
    client,
    `SELECT count() AS n FROM glossary FINAL
      WHERE project_id = {projectId:String} AND term = {term:String} AND deleted = 0`,
    { projectId, term },
  );
  if (existing === 0) return false;
  await client.insert("glossary", [
    {
      project_id: projectId,
      term,
      meaning: "",
      updated_at: toClickhouseTimestamp(Date.now()),
      deleted: 1,
      version: nextVersion(),
    },
  ]);
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
  created_at_ms: number | string;
}

const ANALYSIS_COLS = `id, project_id, title, query, conclusion, author_kind, author_key_id,
       toUnixTimestamp64Milli(created_at) AS created_at_ms`;

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
  client: ClickhouseClient,
  projectId: string,
  input: CreateSavedAnalysisInput,
): Promise<SavedAnalysisRecord> {
  const count = await countRows(
    client,
    `SELECT count() AS n FROM saved_analyses FINAL
      WHERE project_id = {projectId:String} AND deleted = 0`,
    { projectId },
  );
  if (count >= METADATA_LIMITS.savedAnalyses) {
    throw new MetadataLimitError("savedAnalyses", METADATA_LIMITS.savedAnalyses);
  }
  const { analysis } = input;
  const id = randomUUID();
  await client.insert("saved_analyses", [
    {
      id,
      project_id: projectId,
      title: analysis.title,
      query: JSON.stringify(analysis.query),
      conclusion: analysis.conclusion ?? null,
      author_kind: input.authorKind,
      author_key_id: input.authorKeyId,
      created_at: toClickhouseTimestamp(Date.now()),
      deleted: 0,
      version: nextVersion(),
    },
  ]);
  const rows = await client.query<SavedAnalysisRow>(
    `SELECT ${ANALYSIS_COLS} FROM saved_analyses FINAL
      WHERE project_id = {projectId:String} AND id = {id:String} AND deleted = 0`,
    { projectId, id },
  );
  return rowToSavedAnalysis(rows[0]!);
}

/** A project's saved analyses, newest first. */
export async function listSavedAnalyses(
  client: ClickhouseClient,
  projectId: string,
  opts: MetadataListOptions = {},
): Promise<SavedAnalysisRecord[]> {
  const limit = clampMetadataLimit(opts.limit);
  const rows = await client.query<SavedAnalysisRow>(
    `SELECT ${ANALYSIS_COLS} FROM saved_analyses FINAL
      WHERE project_id = {projectId:String} AND deleted = 0
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}`,
    { projectId },
  );
  return rows.map(rowToSavedAnalysis);
}

/** Delete one saved analysis by inserting a tombstone. Returns whether it existed. */
export async function deleteSavedAnalysis(
  client: ClickhouseClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const existing = await countRows(
    client,
    `SELECT count() AS n FROM saved_analyses FINAL
      WHERE project_id = {projectId:String} AND id = {id:String} AND deleted = 0`,
    { projectId, id },
  );
  if (existing === 0) return false;
  await client.insert("saved_analyses", [
    {
      id,
      project_id: projectId,
      title: "",
      query: "{}",
      conclusion: null,
      author_kind: "user",
      author_key_id: null,
      created_at: toClickhouseTimestamp(Date.now()),
      deleted: 1,
      version: nextVersion(),
    },
  ]);
  return true;
}
