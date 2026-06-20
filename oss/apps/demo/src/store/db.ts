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
import type { AnyEvent, NodeTransformEvent, SceneProxy } from "@uptimizr/schema";
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
  "project_id", "session_id", "visitor_id", "event_type", "ts", "sdk_version", "url",
  "scene_id", "source", "handedness", "source_id", "ray_origin", "ray_direction", "position",
  "direction", "hit_point", "screen", "mesh", "fps", "name", "payload", "inserted_at",
  "visible_ms", "centered_ms", "screen_fraction", "texture_bytes", "geometry_bytes", "triangles",
  "vertices", "js_heap_bytes", "cap_from", "cap_to", "frame_time_ms", "frame_time_p95_ms",
  "long_frames", "dpr", "render_scale",
] as const;

/** Ordered `node_samples` columns. */
const NODE_COLUMNS = [
  "project_id", "session_id", "ts", "sdk_version", "scene_id", "node_id", "bone_id",
  "position", "rotation", "scale", "inserted_at", "child_path",
] as const;

function eventValues(row: EventRow, insertedAt: string): string {
  return [
    sqlString(row.project_id), sqlString(row.session_id), sqlString(row.visitor_id),
    sqlString(row.event_type), sqlTimestamp(row.ts), sqlString(row.sdk_version), sqlString(row.url),
    sqlString(row.scene_id), sqlString(row.source), sqlString(row.handedness), sqlString(row.source_id),
    sqlDoubleArray(row.ray_origin), sqlDoubleArray(row.ray_direction), sqlDoubleArray(row.position),
    sqlDoubleArray(row.direction), sqlDoubleArray(row.hit_point), sqlDoubleArray(row.screen),
    sqlString(row.mesh), sqlNumber(row.fps), sqlString(row.name), sqlString(row.payload),
    sqlTimestamp(insertedAt), sqlNumber(row.visible_ms), sqlNumber(row.centered_ms),
    sqlNumber(row.screen_fraction), sqlNumber(row.texture_bytes), sqlNumber(row.geometry_bytes),
    sqlNumber(row.triangles), sqlNumber(row.vertices), sqlNumber(row.js_heap_bytes),
    sqlString(row.cap_from), sqlString(row.cap_to), sqlNumber(row.frame_time_ms),
    sqlNumber(row.frame_time_p95_ms), sqlNumber(row.long_frames), sqlNumber(row.dpr),
    sqlNumber(row.render_scale),
  ].join(",");
}

function nodeValues(row: NodeSampleRow, insertedAt: string): string {
  return [
    sqlString(row.project_id), sqlString(row.session_id), sqlTimestamp(row.ts),
    sqlString(row.sdk_version), sqlString(row.scene_id), sqlString(row.node_id),
    sqlString(row.bone_id), sqlDoubleArray(row.position), sqlDoubleArray(row.rotation),
    sqlDoubleArray(row.scale), sqlTimestamp(insertedAt), sqlString(row.child_path),
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
      await this.#conn.query(`INSERT INTO node_samples (${NODE_COLUMNS.join(",")}) VALUES ${tuples}`);
    }
    await this.#trim("events", MAX_RETAINED_EVENTS);
    await this.#trim("node_samples", MAX_RETAINED_NODE_SAMPLES);
  }

  /** Drop the oldest rows of `table` beyond `max`, keeping memory bounded. */
  async #trim(table: "events" | "node_samples", max: number): Promise<void> {
    const counted = (await this.all<{ n: number }>({
      query: `SELECT count(*) AS n FROM ${table}`,
      query_params: {},
    }))[0];
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

  /** Clear all collected data while keeping the schema and demo project. */
  async reset(): Promise<void> {
    await this.#conn.query("DELETE FROM events");
    await this.#conn.query("DELETE FROM node_samples");
    await this.#conn.query("DELETE FROM scene_representations");
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
