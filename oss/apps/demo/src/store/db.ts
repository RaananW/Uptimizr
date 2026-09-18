import * as duckdb from "@duckdb/duckdb-wasm";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import {
  DUCKDB_MIGRATIONS,
  toEventRow,
  toNodeSampleRow,
  type EventRow,
  type NodeSampleRow,
  type QuerySpec,
} from "@uptimizr/db/query";
import { LIMITS } from "@uptimizr/schema";
import type {
  Annotation,
  AnyEvent,
  NodeTransformEvent,
  SavedAnalysis,
  SceneProxy,
  SceneRegion,
} from "@uptimizr/schema";
import { tableToRows, type ArrowTableLike } from "./arrow.js";
import {
  DEMO_PROJECT_ID,
  DEMO_PROJECT_NAME,
  MAX_RETAINED_EVENTS,
  MAX_RETAINED_NODE_SAMPLES,
} from "./constants.js";
import { toPositionalQuery } from "./params.js";

/** The local DuckDB-Wasm asset bundles, served same-origin so the SW can cache them. */
const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

/** The same-origin DuckDB-Wasm asset URLs, exposed so the prepare flow + SW can precache them. */
export const DUCKDB_ASSET_URLS: readonly string[] = [mvpWasm, mvpWorker, ehWasm, ehWorker];

/** Escape and single-quote a string for safe inlining in a DuckDB SQL literal. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Render a finite number, or SQL `NULL` for non-finite values. */
function sqlNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "NULL";
}

/** Render a `number[]` as a typed DuckDB `DOUBLE[]` literal. */
function sqlDoubleArray(values: number[]): string {
  return `CAST([${values.map(sqlNumber).join(",")}] AS DOUBLE[])`;
}

/** Render a naive-UTC timestamp string as a DuckDB `TIMESTAMP` literal. */
function sqlTimestamp(value: string): string {
  return `TIMESTAMP ${sqlString(value)}`;
}

/** Ordered `events` columns (explicit so we never rely on physical column order). */
const EVENT_COLUMNS = [
  "project_id",
  "session_id",
  "visitor_id",
  "event_type",
  "ts",
  "sdk_version",
  "url",
  "scene_id",
  "source",
  "handedness",
  "source_id",
  "ray_origin",
  "ray_direction",
  "position",
  "direction",
  "hit_point",
  "screen",
  "mesh",
  "fps",
  "name",
  "payload",
  "inserted_at",
  "visible_ms",
  "centered_ms",
  "screen_fraction",
  "texture_bytes",
  "geometry_bytes",
  "triangles",
  "vertices",
  "js_heap_bytes",
  "cap_from",
  "cap_to",
  "frame_time_ms",
  "frame_time_p95_ms",
  "long_frames",
  "dpr",
  "render_scale",
] as const;

/** Ordered `node_samples` columns. */
const NODE_COLUMNS = [
  "project_id",
  "session_id",
  "ts",
  "sdk_version",
  "scene_id",
  "node_id",
  "bone_id",
  "position",
  "rotation",
  "scale",
  "inserted_at",
  "child_path",
] as const;

function eventValues(row: EventRow, insertedAt: string): string {
  return [
    sqlString(row.project_id),
    sqlString(row.session_id),
    sqlString(row.visitor_id),
    sqlString(row.event_type),
    sqlTimestamp(row.ts),
    sqlString(row.sdk_version),
    sqlString(row.url),
    sqlString(row.scene_id),
    sqlString(row.source),
    sqlString(row.handedness),
    sqlString(row.source_id),
    sqlDoubleArray(row.ray_origin),
    sqlDoubleArray(row.ray_direction),
    sqlDoubleArray(row.position),
    sqlDoubleArray(row.direction),
    sqlDoubleArray(row.hit_point),
    sqlDoubleArray(row.screen),
    sqlString(row.mesh),
    sqlNumber(row.fps),
    sqlString(row.name),
    sqlString(row.payload),
    sqlTimestamp(insertedAt),
    sqlNumber(row.visible_ms),
    sqlNumber(row.centered_ms),
    sqlNumber(row.screen_fraction),
    sqlNumber(row.texture_bytes),
    sqlNumber(row.geometry_bytes),
    sqlNumber(row.triangles),
    sqlNumber(row.vertices),
    sqlNumber(row.js_heap_bytes),
    sqlString(row.cap_from),
    sqlString(row.cap_to),
    sqlNumber(row.frame_time_ms),
    sqlNumber(row.frame_time_p95_ms),
    sqlNumber(row.long_frames),
    sqlNumber(row.dpr),
    sqlNumber(row.render_scale),
  ].join(",");
}

function nodeValues(row: NodeSampleRow, insertedAt: string): string {
  return [
    sqlString(row.project_id),
    sqlString(row.session_id),
    sqlTimestamp(row.ts),
    sqlString(row.sdk_version),
    sqlString(row.scene_id),
    sqlString(row.node_id),
    sqlString(row.bone_id),
    sqlDoubleArray(row.position),
    sqlDoubleArray(row.rotation),
    sqlDoubleArray(row.scale),
    sqlTimestamp(insertedAt),
    sqlString(row.child_path),
  ].join(",");
}

/** Max rows per multi-row INSERT, to bound generated SQL size. */
const INSERT_CHUNK = 400;

function* chunk<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Raw `scene_representations` row as selected (proxy/bounds are JSON text). */
interface SceneRepresentationRow {
  scene_id: string;
  label: string | null;
  kind: string;
  up_axis: string;
  unit_scale: number;
  bounds: string | null;
  proxy: string | null;
  content_hash: string | null;
  proxy_version: number | null;
  captured_at_ms: number | null;
  updated_at_ms: number;
}

/** A scene representation as returned to the dashboard (proxy blob parsed). */
export interface DemoSceneRepresentation {
  projectId: string;
  sceneId: string;
  label: string | null;
  kind: "proxy";
  upAxis: string;
  unitScale: number;
  bounds: number[] | null;
  proxy: SceneProxy | null;
  assetUrl: null;
  contentHash: string | null;
  proxyVersion: number | null;
  capturedAt: string | null;
  updatedAt: string;
}

/** Raw `scene_regions` row as selected (`bounds` is JSON text). */
interface SceneRegionRow {
  scene_id: string;
  region_id: string;
  label: string;
  description: string | null;
  bounds: string;
  updated_at_ms: number;
}

/** A stored scene region as returned to the dashboard (`bounds` parsed). */
export interface DemoSceneRegion {
  projectId: string;
  sceneId: string;
  regionId: string;
  label: string;
  description: string | null;
  bounds: number[];
  updatedAt: string;
}

// --- Project metadata rows (#310, ADR 0051 §5) -----------------------------

/** Raw `annotations` row as selected (timestamps as epoch-ms). */
interface AnnotationRow {
  id: string;
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

/** Raw `glossary` row as selected. */
interface GlossaryRow {
  term: string;
  meaning: string;
  updated_at_ms: number;
}

/** Raw `saved_analyses` row as selected (`query` is JSON text). */
interface SavedAnalysisRow {
  id: string;
  title: string;
  query: string;
  conclusion: string | null;
  author_kind: string;
  author_key_id: string | null;
  created_at_ms: number;
}

/** One stored annotation, in the shape the collector's endpoint returns. */
export interface DemoAnnotation {
  id: string;
  projectId: string;
  targetKind: string;
  targetId: string | null;
  since: string | null;
  until: string | null;
  text: string;
  authorKind: "user" | "agent";
  authorKeyId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One stored glossary entry, in the shape the collector's endpoint returns. */
export interface DemoGlossaryEntry {
  projectId: string;
  term: string;
  meaning: string;
  updatedAt: string;
}

/** One stored saved analysis, in the shape the collector's endpoint returns. */
export interface DemoSavedAnalysis {
  id: string;
  projectId: string;
  title: string;
  query: Record<string, unknown>;
  conclusion: string | null;
  authorKind: "user" | "agent";
  authorKeyId: string | null;
  createdAt: string;
}

/**
 * Thrown when a metadata write would take the demo project past a table's cap —
 * the browser-side twin of `@uptimizr/db`'s `MetadataLimitError`, which the demo
 * cannot import because it would drag the Node store into the bundle.
 */
export class DemoMetadataLimitError extends Error {
  constructor(
    readonly table: string,
    readonly limit: number,
  ) {
    super(`project has reached its limit of ${limit} ${table} rows`);
    this.name = "DemoMetadataLimitError";
  }
}

/**
 * Parse a stored `query` JSON column back into an object — the browser twin of
 * `@uptimizr/db`'s `parseSavedAnalysisQuery` (that module reaches for
 * `node:crypto`, so the demo cannot import it). A row written by this store
 * always parses; anything else degrades to `{}` rather than failing a listing.
 */
function parseSavedAnalysisQuery(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Map a raw annotation row to the dashboard-facing shape. */
function rowToAnnotation(row: AnnotationRow): DemoAnnotation {
  return {
    id: row.id,
    projectId: DEMO_PROJECT_ID,
    targetKind: row.target_kind,
    targetId: row.target_id ?? null,
    since: row.since_ms == null ? null : new Date(Number(row.since_ms)).toISOString(),
    until: row.until_ms == null ? null : new Date(Number(row.until_ms)).toISOString(),
    text: row.text,
    authorKind: row.author_kind as "user" | "agent",
    authorKeyId: row.author_key_id ?? null,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
  };
}

/** Map a raw region row to the dashboard-facing shape (JSON parsed). */
function rowToRegion(row: SceneRegionRow): DemoSceneRegion {
  return {
    projectId: DEMO_PROJECT_ID,
    sceneId: row.scene_id,
    regionId: row.region_id,
    label: row.label,
    description: row.description ?? null,
    bounds: JSON.parse(row.bounds) as number[],
    updatedAt: new Date(row.updated_at_ms).toISOString(),
  };
}

/** A scene representation summary (no proxy blob) for the registry listing. */
export interface SceneRepresentationSummary {
  sceneId: string;
  label: string | null;
  kind: "proxy";
  bounds: number[] | null;
  contentHash: string | null;
  capturedAt: string | null;
  updatedAt: string;
}

/** Map a raw representation row to the dashboard-facing shape (JSON parsed). */
function rowToRepresentation(row: SceneRepresentationRow): DemoSceneRepresentation {
  return {
    projectId: DEMO_PROJECT_ID,
    sceneId: row.scene_id,
    label: row.label ?? null,
    kind: "proxy",
    upAxis: row.up_axis,
    unitScale: Number(row.unit_scale),
    bounds: row.bounds ? (JSON.parse(row.bounds) as number[]) : null,
    proxy: row.proxy ? (JSON.parse(row.proxy) as SceneProxy) : null,
    assetUrl: null,
    contentHash: row.content_hash ?? null,
    proxyVersion: row.proxy_version ?? null,
    capturedAt: row.captured_at_ms == null ? null : new Date(row.captured_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
  };
}

/**
 * The in-browser analytics database: a memory-only DuckDB-Wasm instance running
 * in a Web Worker. It owns the same schema as the self-hosted DuckDB store
 * (replayed from the shared {@link DUCKDB_MIGRATIONS}) and answers the same
 * dialect-agnostic query specs, so the dashboard sees identical results — only
 * the execution engine differs. Nothing is persisted to disk (no OPFS), so the
 * database evaporates when the page closes and never burdens the device.
 */
export class WasmDb {
  #db: duckdb.AsyncDuckDB;
  #conn: duckdb.AsyncDuckDBConnection;

  private constructor(db: duckdb.AsyncDuckDB, conn: duckdb.AsyncDuckDBConnection) {
    this.#db = db;
    this.#conn = conn;
  }

  /** Bootstrap DuckDB-Wasm, open a memory-only database, and migrate the schema. */
  static async create(): Promise<WasmDb> {
    const bundle = await duckdb.selectBundle(BUNDLES);
    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    // Memory-only: an unnamed database lives entirely in worker memory.
    await db.open({ path: ":memory:" });
    const conn = await db.connect();
    const self = new WasmDb(db, conn);
    await self.#migrate();
    await self.#seedMetadata();
    return self;
  }

  async #migrate(): Promise<void> {
    for (const migration of DUCKDB_MIGRATIONS) {
      await this.#conn.query(migration.sql);
    }
  }

  /** Insert the well-known demo project so the scene registry has a home. */
  async #seedMetadata(): Promise<void> {
    await this.#conn.query(
      `INSERT INTO projects (id, name) VALUES (${sqlString(DEMO_PROJECT_ID)}, ${sqlString(
        DEMO_PROJECT_NAME,
      )}) ON CONFLICT (id) DO NOTHING`,
    );
  }

  /** Run a dialect-agnostic {@link QuerySpec} and return normalized plain rows. */
  async all<T>(spec: QuerySpec): Promise<T[]> {
    const { sql, values } = toPositionalQuery(spec);
    if (values.length === 0) {
      const table = (await this.#conn.query(sql)) as unknown as ArrowTableLike;
      return tableToRows<T>(table);
    }
    const stmt = await this.#conn.prepare(sql);
    try {
      const table = (await stmt.query(...values)) as unknown as ArrowTableLike;
      return tableToRows<T>(table);
    } finally {
      await stmt.close();
    }
  }

  /** Run a statement for its side effects only. */
  async run(sql: string): Promise<void> {
    await this.#conn.query(sql);
  }

  /**
   * Persist a batch of validated events, splitting `node_transform` into the
   * dedicated `node_samples` table (ADR 0027) exactly like the Node store, then
   * trim to the rolling retention bound so memory stays capped.
   */
  async insertEvents(events: readonly AnyEvent[]): Promise<void> {
    if (events.length === 0) return;
    const insertedAt = formatNow();
    const wide = events.filter((e) => e.type !== "node_transform");
    const nodes = events.filter((e): e is NodeTransformEvent => e.type === "node_transform");

    for (const group of chunk(wide, INSERT_CHUNK)) {
      const tuples = group.map((e) => `(${eventValues(toEventRow(e), insertedAt)})`).join(",");
      await this.#conn.query(`INSERT INTO events (${EVENT_COLUMNS.join(",")}) VALUES ${tuples}`);
    }
    for (const group of chunk(nodes, INSERT_CHUNK)) {
      const tuples = group.map((e) => `(${nodeValues(toNodeSampleRow(e), insertedAt)})`).join(",");
      await this.#conn.query(
        `INSERT INTO node_samples (${NODE_COLUMNS.join(",")}) VALUES ${tuples}`,
      );
    }
    await this.#trim("events", MAX_RETAINED_EVENTS);
    await this.#trim("node_samples", MAX_RETAINED_NODE_SAMPLES);
  }

  /** Drop the oldest rows of `table` beyond `max`, keeping memory bounded. */
  async #trim(table: "events" | "node_samples", max: number): Promise<void> {
    const counted = (
      await this.all<{ n: number }>({
        query: `SELECT count(*) AS n FROM ${table}`,
        query_params: {},
      })
    )[0];
    const n = counted?.n ?? 0;
    if (n <= max) return;
    await this.#conn.query(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY ts ASC LIMIT ${n - max})`,
    );
  }

  /**
   * Upsert a scene **proxy** (ADR 0014) keyed by `sceneId` so world/gaze heatmaps
   * and session replay can render the scene's geometry. Mirrors the Node store's
   * `upsertSceneProxy`: stores the full proxy as JSON and promotes the
   * bounds/hash/version/captured-at to columns for cheap listing.
   */
  async putSceneProxy(proxy: SceneProxy, label: string | null): Promise<void> {
    const capturedAt = formatTimestamp(proxy.capturedAt);
    await this.#conn.query(
      `INSERT INTO scene_representations
         (project_id, scene_id, label, kind, up_axis, unit_scale, bounds, proxy,
          asset_url, content_hash, proxy_version, captured_at, updated_at)
       VALUES (${sqlString(DEMO_PROJECT_ID)}, ${sqlString(proxy.sceneId)},
               ${label == null ? "NULL" : sqlString(label)}, 'proxy',
               ${sqlString(proxy.upAxis)}, ${sqlNumber(proxy.unitScale)},
               ${sqlString(JSON.stringify(proxy.bounds))}, ${sqlString(JSON.stringify(proxy))},
               NULL, ${sqlString(proxy.contentHash)}, ${sqlNumber(proxy.version)},
               ${sqlTimestamp(capturedAt)}, now())
       ON CONFLICT (project_id, scene_id) DO UPDATE SET
         label         = COALESCE(EXCLUDED.label, scene_representations.label),
         kind          = 'proxy',
         up_axis       = EXCLUDED.up_axis,
         unit_scale    = EXCLUDED.unit_scale,
         bounds        = EXCLUDED.bounds,
         proxy         = EXCLUDED.proxy,
         asset_url     = NULL,
         content_hash  = EXCLUDED.content_hash,
         proxy_version = EXCLUDED.proxy_version,
         captured_at   = EXCLUDED.captured_at,
         updated_at    = now()`,
    );
  }

  /** Fetch one scene representation (including the proxy blob), or `null`. */
  async getSceneRepresentation(sceneId: string): Promise<DemoSceneRepresentation | null> {
    const rows = await this.all<SceneRepresentationRow>({
      query: `SELECT scene_id, label, kind, up_axis, unit_scale, bounds, proxy,
                     content_hash, proxy_version,
                     epoch_ms(captured_at) AS captured_at_ms,
                     epoch_ms(updated_at) AS updated_at_ms
              FROM scene_representations
              WHERE project_id = ${sqlString(DEMO_PROJECT_ID)} AND scene_id = ${sqlString(sceneId)}`,
      query_params: {},
    });
    const row = rows[0];
    return row ? rowToRepresentation(row) : null;
  }

  /** List the demo project's scene representations (summaries, no proxy blob). */
  async listSceneRepresentations(): Promise<SceneRepresentationSummary[]> {
    const rows = await this.all<Omit<SceneRepresentationRow, "proxy">>({
      query: `SELECT scene_id, label, kind, up_axis, unit_scale, bounds, content_hash,
                     proxy_version,
                     epoch_ms(captured_at) AS captured_at_ms,
                     epoch_ms(updated_at) AS updated_at_ms
              FROM scene_representations
              WHERE project_id = ${sqlString(DEMO_PROJECT_ID)}
              ORDER BY updated_at DESC`,
      query_params: {},
    });
    return rows.map((row) => ({
      sceneId: row.scene_id,
      label: row.label ?? null,
      kind: "proxy",
      bounds: row.bounds ? (JSON.parse(row.bounds) as number[]) : null,
      contentHash: row.content_hash ?? null,
      capturedAt: row.captured_at_ms == null ? null : new Date(row.captured_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    }));
  }

  /**
   * Replace a scene's whole **region** set (ADR 0051 §2), mirroring the Node
   * store's `putSceneRegions`: regions are declared, not patched, so a region
   * left out is removed and an empty array clears the scene.
   */
  async putSceneRegions(sceneId: string, regions: readonly SceneRegion[]): Promise<void> {
    await this.#conn.query(
      `DELETE FROM scene_regions
       WHERE project_id = ${sqlString(DEMO_PROJECT_ID)} AND scene_id = ${sqlString(sceneId)}`,
    );
    for (const region of regions) {
      await this.#conn.query(
        `INSERT INTO scene_regions
           (project_id, scene_id, region_id, label, description, bounds, updated_at)
         VALUES (${sqlString(DEMO_PROJECT_ID)}, ${sqlString(sceneId)},
                 ${sqlString(region.id)}, ${sqlString(region.label)},
                 ${region.description == null ? "NULL" : sqlString(region.description)},
                 ${sqlString(JSON.stringify(region.bounds))}, now())`,
      );
    }
  }

  /** Read one scene's regions, ordered by region id. */
  async getSceneRegions(sceneId: string): Promise<DemoSceneRegion[]> {
    const rows = await this.all<SceneRegionRow>({
      query: `SELECT scene_id, region_id, label, description, bounds,
                     epoch_ms(updated_at) AS updated_at_ms
              FROM scene_regions
              WHERE project_id = ${sqlString(DEMO_PROJECT_ID)} AND scene_id = ${sqlString(sceneId)}
              ORDER BY region_id`,
      query_params: {},
    });
    return rows.map(rowToRegion);
  }

  /** The demo project's whole region vocabulary (names only, no boxes). */
  async listSceneRegions(): Promise<Array<{ sceneId: string; regionId: string; label: string }>> {
    const rows = await this.all<Pick<SceneRegionRow, "scene_id" | "region_id" | "label">>({
      query: `SELECT scene_id, region_id, label
              FROM scene_regions
              WHERE project_id = ${sqlString(DEMO_PROJECT_ID)}
              ORDER BY scene_id, region_id`,
      query_params: {},
    });
    return rows.map((row) => ({
      sceneId: row.scene_id,
      regionId: row.region_id,
      label: row.label,
    }));
  }

  // --- Project metadata (#310, ADR 0051 §5) --------------------------------
  //
  // Annotations, glossary and saved analyses, mirroring the Node store's
  // accessors so the demo exercises the same contract the collector does. The
  // tables come from `DUCKDB_MIGRATIONS`, which this store already replays, so
  // there is nothing extra to create here.

  /** Create one annotation and return the stored row. */
  async createAnnotation(
    annotation: Annotation,
    author: { authorKind: "user" | "agent"; authorKeyId: string | null },
  ): Promise<DemoAnnotation> {
    if ((await this.#count("annotations")) >= LIMITS.maxProjectAnnotations) {
      throw new DemoMetadataLimitError("annotations", LIMITS.maxProjectAnnotations);
    }
    const id = crypto.randomUUID();
    await this.#conn.query(
      `INSERT INTO annotations
         (id, project_id, target_kind, target_id, since, until, text,
          author_kind, author_key_id, created_at, updated_at)
       VALUES (${sqlString(id)}, ${sqlString(DEMO_PROJECT_ID)},
               ${sqlString(annotation.targetKind)},
               ${annotation.targetId == null ? "NULL" : sqlString(annotation.targetId)},
               ${annotation.since == null ? "NULL" : `make_timestamp(${annotation.since * 1000})`},
               ${annotation.until == null ? "NULL" : `make_timestamp(${annotation.until * 1000})`},
               ${sqlString(annotation.text)}, ${sqlString(author.authorKind)},
               ${author.authorKeyId == null ? "NULL" : sqlString(author.authorKeyId)},
               now(), now())`,
    );
    const [row] = await this.listAnnotations({ id });
    return row!;
  }

  /** The demo project's annotations, newest first. */
  async listAnnotations(
    opts: {
      id?: string;
      targetKind?: string;
      targetId?: string;
      since?: number;
      until?: number;
    } = {},
  ): Promise<DemoAnnotation[]> {
    const where = [`project_id = ${sqlString(DEMO_PROJECT_ID)}`];
    if (opts.id != null) where.push(`id = ${sqlString(opts.id)}`);
    if (opts.targetKind != null) where.push(`target_kind = ${sqlString(opts.targetKind)}`);
    if (opts.targetId != null) where.push(`target_id = ${sqlString(opts.targetId)}`);
    if (opts.since != null) {
      where.push(`(until IS NULL OR until >= make_timestamp(${Math.trunc(opts.since) * 1000}))`);
    }
    if (opts.until != null) {
      where.push(`(since IS NULL OR since < make_timestamp(${Math.trunc(opts.until) * 1000}))`);
    }
    const rows = await this.all<AnnotationRow>({
      query: `SELECT id, target_kind, target_id, epoch_ms(since) AS since_ms,
                     epoch_ms(until) AS until_ms, text, author_kind, author_key_id,
                     epoch_ms(created_at) AS created_at_ms, epoch_ms(updated_at) AS updated_at_ms
              FROM annotations
              WHERE ${where.join(" AND ")}
              ORDER BY created_at DESC, id DESC
              LIMIT ${LIMITS.maxProjectAnnotations}`,
      query_params: {},
    });
    return rows.map(rowToAnnotation);
  }

  /** Delete one annotation. Returns whether it existed. */
  async deleteAnnotation(id: string): Promise<boolean> {
    if ((await this.listAnnotations({ id })).length === 0) return false;
    await this.#conn.query(
      `DELETE FROM annotations
        WHERE project_id = ${sqlString(DEMO_PROJECT_ID)} AND id = ${sqlString(id)}`,
    );
    return true;
  }

  /** Upsert one glossary entry (the term is the identity). */
  async putGlossaryEntry(term: string, meaning: string): Promise<DemoGlossaryEntry> {
    const existing = await this.listGlossary();
    if (
      !existing.some((entry) => entry.term === term) &&
      existing.length >= LIMITS.maxProjectGlossaryEntries
    ) {
      throw new DemoMetadataLimitError("glossary", LIMITS.maxProjectGlossaryEntries);
    }
    await this.#conn.query(
      `INSERT INTO glossary (project_id, term, meaning, updated_at)
       VALUES (${sqlString(DEMO_PROJECT_ID)}, ${sqlString(term)}, ${sqlString(meaning)}, now())
       ON CONFLICT (project_id, term)
       DO UPDATE SET meaning = EXCLUDED.meaning, updated_at = now()`,
    );
    return (await this.listGlossary()).find((entry) => entry.term === term)!;
  }

  /** The demo project's whole glossary, ordered by term. */
  async listGlossary(): Promise<DemoGlossaryEntry[]> {
    const rows = await this.all<GlossaryRow>({
      query: `SELECT term, meaning, epoch_ms(updated_at) AS updated_at_ms
              FROM glossary
              WHERE project_id = ${sqlString(DEMO_PROJECT_ID)}
              ORDER BY term
              LIMIT ${LIMITS.maxProjectGlossaryEntries}`,
      query_params: {},
    });
    return rows.map((row) => ({
      projectId: DEMO_PROJECT_ID,
      term: row.term,
      meaning: row.meaning,
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    }));
  }

  /** Delete one term. Returns whether it existed. */
  async deleteGlossaryEntry(term: string): Promise<boolean> {
    if (!(await this.listGlossary()).some((entry) => entry.term === term)) return false;
    await this.#conn.query(
      `DELETE FROM glossary
        WHERE project_id = ${sqlString(DEMO_PROJECT_ID)} AND term = ${sqlString(term)}`,
    );
    return true;
  }

  /** Create one saved analysis and return the stored row. */
  async createSavedAnalysis(
    analysis: SavedAnalysis,
    author: { authorKind: "user" | "agent"; authorKeyId: string | null },
  ): Promise<DemoSavedAnalysis> {
    if ((await this.#count("saved_analyses")) >= LIMITS.maxProjectSavedAnalyses) {
      throw new DemoMetadataLimitError("savedAnalyses", LIMITS.maxProjectSavedAnalyses);
    }
    const id = crypto.randomUUID();
    await this.#conn.query(
      `INSERT INTO saved_analyses
         (id, project_id, title, query, conclusion, author_kind, author_key_id, created_at)
       VALUES (${sqlString(id)}, ${sqlString(DEMO_PROJECT_ID)}, ${sqlString(analysis.title)},
               ${sqlString(JSON.stringify(analysis.query))},
               ${analysis.conclusion == null ? "NULL" : sqlString(analysis.conclusion)},
               ${sqlString(author.authorKind)},
               ${author.authorKeyId == null ? "NULL" : sqlString(author.authorKeyId)},
               now())`,
    );
    return (await this.listSavedAnalyses()).find((row) => row.id === id)!;
  }

  /** The demo project's saved analyses, newest first. */
  async listSavedAnalyses(): Promise<DemoSavedAnalysis[]> {
    const rows = await this.all<SavedAnalysisRow>({
      query: `SELECT id, title, query, conclusion, author_kind, author_key_id,
                     epoch_ms(created_at) AS created_at_ms
              FROM saved_analyses
              WHERE project_id = ${sqlString(DEMO_PROJECT_ID)}
              ORDER BY created_at DESC, id DESC
              LIMIT ${LIMITS.maxProjectSavedAnalyses}`,
      query_params: {},
    });
    return rows.map((row) => ({
      id: row.id,
      projectId: DEMO_PROJECT_ID,
      title: row.title,
      query: parseSavedAnalysisQuery(row.query),
      conclusion: row.conclusion ?? null,
      authorKind: row.author_kind as "user" | "agent",
      authorKeyId: row.author_key_id ?? null,
      createdAt: new Date(row.created_at_ms).toISOString(),
    }));
  }

  /** Delete one saved analysis. Returns whether it existed. */
  async deleteSavedAnalysis(id: string): Promise<boolean> {
    if (!(await this.listSavedAnalyses()).some((row) => row.id === id)) return false;
    await this.#conn.query(
      `DELETE FROM saved_analyses
        WHERE project_id = ${sqlString(DEMO_PROJECT_ID)} AND id = ${sqlString(id)}`,
    );
    return true;
  }

  /** `SELECT count(*)` on one of the demo project's metadata tables. */
  async #count(table: "annotations" | "saved_analyses"): Promise<number> {
    const rows = await this.all<{ n: number | bigint }>({
      query: `SELECT count(*) AS n FROM ${table} WHERE project_id = ${sqlString(DEMO_PROJECT_ID)}`,
      query_params: {},
    });
    return Number(rows[0]?.n ?? 0);
  }

  /** Clear all collected data while keeping the schema and demo project. */
  async reset(): Promise<void> {
    await this.#conn.query("DELETE FROM events");
    await this.#conn.query("DELETE FROM node_samples");
    await this.#conn.query("DELETE FROM scene_representations");
    await this.#conn.query("DELETE FROM scene_regions");
    await this.#conn.query("DELETE FROM annotations");
    await this.#conn.query("DELETE FROM glossary");
    await this.#conn.query("DELETE FROM saved_analyses");
  }

  /** Tear down the connection and terminate the worker (proactive teardown). */
  async dispose(): Promise<void> {
    await this.#conn.close();
    await this.#db.terminate();
  }
}

/** A given epoch-ms instant as a naive-UTC `YYYY-MM-DD HH:MM:SS.mmm` string. */
function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

/** Current time as a naive-UTC `YYYY-MM-DD HH:MM:SS.mmm` string. */
function formatNow(): string {
  return formatTimestamp(Date.now());
}
