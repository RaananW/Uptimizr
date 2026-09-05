import {
  mssqlDialect,
  nodeSampleRowToEvent,
  toEventRow,
  toNodeSampleRow,
  type EventRow,
  type NodeSampleRow,
  type SessionMeta,
} from "@uptimizr/db";
import { anyEventSchema, type AnyEvent, type NodeTransformEvent } from "@uptimizr/schema";
import type { MssqlClient, MssqlExecutor } from "./client.js";

export type { SessionMeta };

/**
 * Column order of the wide `events` table as written by {@link insertEvents}
 * (must match migration `0001_events`; `inserted_at` is engine-defaulted).
 */
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
  "fov",
  "aspect",
  "near",
  "name",
  "payload",
] as const satisfies ReadonlyArray<keyof EventRow>;

/** Column order of `node_samples` as written by {@link insertEvents}. */
const NODE_SAMPLE_COLUMNS = [
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
  "child_path",
] as const satisfies ReadonlyArray<keyof NodeSampleRow>;

/**
 * TDS caps a statement at 2100 bound parameters (and a row constructor at
 * 1000 rows); rows per multi-row `INSERT` are derived from the column count.
 */
const INSERT_MAX_PARAMS = 2000;

/**
 * The shared row mappers render `ts` as `YYYY-MM-DD HH:MM:SS.mmm`; SQL Server
 * parses the ISO-8601 `T` form independently of language / `DATEFORMAT`.
 */
const toIsoTimestamp = (naiveUtc: string) => naiveUtc.replace(" ", "T");

/**
 * Serialize one mapped row for binding: vectors become JSON number arrays (the
 * store's array representation — see `mssqlDialect`) and `ts` the ISO literal.
 */
function bindable(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value)) out[key] = JSON.stringify(value);
    else if (key === "ts" && typeof value === "string") out[key] = toIsoTimestamp(value);
    else out[key] = value;
  }
  return out;
}

/** Multi-row `INSERT INTO table (cols) VALUES (@p1,…),(@pn,…)` in chunks. */
async function insertRows(
  tx: MssqlExecutor,
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  const chunkRows = Math.max(1, Math.floor(INSERT_MAX_PARAMS / columns.length));
  for (let start = 0; start < rows.length; start += chunkRows) {
    const chunk = rows.slice(start, start + chunkRows);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((col) => `@p${values.push(row[col])}`);
      return `(${placeholders.join(", ")})`;
    });
    await tx.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`,
      values,
    );
  }
}

/**
 * Batched insert of validated events. Reuses the shared {@link toEventRow} mapper
 * so the promoted columns match the DuckDB store exactly; vectors land as JSON
 * arrays and `payload` as JSON text.
 *
 * `node_transform` events (ADR 0027) are split out into the dedicated
 * `node_samples` table rather than the wide `events` table. Both inserts run in
 * one transaction, so a batch is never partially applied.
 */
export async function insertEvents(client: MssqlClient, events: readonly AnyEvent[]): Promise<void> {
  if (events.length === 0) return;

  const wideRows: Record<string, unknown>[] = [];
  const nodeRows: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.type === "node_transform") {
      nodeRows.push(bindable({ ...toNodeSampleRow(event as NodeTransformEvent) }));
    } else {
      wideRows.push(bindable({ ...toEventRow(event) }));
    }
  }

  await client.transaction(async (tx) => {
    if (wideRows.length > 0) await insertRows(tx, "dbo.events", EVENT_COLUMNS, wideRows);
    if (nodeRows.length > 0) {
      await insertRows(tx, "dbo.node_samples", NODE_SAMPLE_COLUMNS, nodeRows);
    }
  });
}

/** Raw `node_samples` row shape as read back from SQL Server (vectors as JSON text). */
interface NodeSampleReadRow {
  ts_ms: number;
  sdk_version: string;
  scene_id: string;
  node_id: string;
  bone_id: string;
  child_path: string;
  position: string;
  rotation: string;
  scale: string;
}

function parseVector(json: string | null | undefined): number[] {
  return json ? (JSON.parse(json) as number[]) : [];
}

/**
 * Read a session's stored `node_transform` samples (ADR 0027), reconstructed
 * into replay-complete events in `ts` order.
 */
async function readSessionNodeSamples(
  client: MssqlClient,
  projectId: string,
  sessionId: string,
): Promise<NodeTransformEvent[]> {
  const rows = await client.query<NodeSampleReadRow>(
    `SELECT ${mssqlDialect.epochMs("ts")} AS ts_ms, sdk_version, scene_id, node_id,
            bone_id, child_path, position, rotation, scale
     FROM dbo.node_samples
     WHERE project_id = @p1 AND session_id = @p2
     ORDER BY ts ASC`,
    [projectId, sessionId],
  );
  return rows.map((row) =>
    nodeSampleRowToEvent(
      {
        project_id: projectId,
        session_id: sessionId,
        sdk_version: row.sdk_version,
        scene_id: row.scene_id,
        node_id: row.node_id,
        bone_id: row.bone_id,
        child_path: row.child_path,
        position: parseVector(row.position),
        rotation: parseVector(row.rotation),
        scale: parseVector(row.scale),
      },
      row.ts_ms,
    ),
  );
}

/**
 * Merge two `ts`-ordered event streams into one ascending stream. Stable on ties
 * (wide events before node samples at the same `ts`), so replay sees a single
 * ordered timeline (ADR 0027 §8).
 */
function mergeByTs(wide: readonly AnyEvent[], nodes: readonly AnyEvent[]): AnyEvent[] {
  const merged: AnyEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < wide.length && j < nodes.length) {
    if (nodes[j]!.ts < wide[i]!.ts) merged.push(nodes[j++]!);
    else merged.push(wide[i++]!);
  }
  while (i < wide.length) merged.push(wide[i++]!);
  while (j < nodes.length) merged.push(nodes[j++]!);
  return merged;
}

/** `payload` is JSON text; parse and re-validate so reads stay schema-exact. */
function parsePayload(payload: unknown): AnyEvent | undefined {
  const value = typeof payload === "string" ? JSON.parse(payload) : payload;
  const parsed = anyEventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function readSessionWideEvents(
  client: MssqlClient,
  projectId: string,
  sessionId: string,
): Promise<AnyEvent[]> {
  const rows = await client.query<{ payload: unknown }>(
    `SELECT payload FROM dbo.events
     WHERE project_id = @p1 AND session_id = @p2
     ORDER BY ts ASC`,
    [projectId, sessionId],
  );
  const events: AnyEvent[] = [];
  for (const row of rows) {
    const event = parsePayload(row.payload);
    if (event) events.push(event);
  }
  return events;
}

/**
 * Ordered read of a single session's events for replay/timeline. Returns
 * fully-parsed, schema-validated events in `ts` order, merging the wide `events`
 * table with the dedicated `node_samples` table (ADR 0027 §9). Gated upstream by
 * `ENABLE_RAW_SESSION_RETENTION` (ADR 0003) — this function does not enforce it.
 */
export async function getSessionEvents(
  client: MssqlClient,
  projectId: string,
  sessionId: string,
): Promise<AnyEvent[]> {
  const events = await readSessionWideEvents(client, projectId, sessionId);
  const nodes = await readSessionNodeSamples(client, projectId, sessionId);
  return nodes.length > 0 ? mergeByTs(events, nodes) : events;
}

/**
 * Streaming counterpart to {@link getSessionEvents}: yields one validated event
 * at a time in `ts` order (the path behind the collector's NDJSON replay
 * response, ADR 0015). The session is read as one ordered result set; node
 * samples are merged in by `ts` before yielding.
 */
export async function* streamSessionEvents(
  client: MssqlClient,
  projectId: string,
  sessionId: string,
): AsyncGenerator<AnyEvent> {
  const wide = await readSessionWideEvents(client, projectId, sessionId);
  const nodes = await readSessionNodeSamples(client, projectId, sessionId);
  const ordered = nodes.length > 0 ? mergeByTs(wide, nodes) : wide;
  for (const event of ordered) yield event;
}

/**
 * Read a session's stored metadata (`device`/`scene`/`user`) from its
 * `session_start` event. Returns `null` when the session has no start event.
 */
export async function getSessionMeta(
  client: MssqlClient,
  projectId: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const rows = await client.query<{ payload: unknown; ts: string }>(
    `SELECT TOP 1 payload, ts FROM dbo.events
     WHERE project_id = @p1 AND session_id = @p2
       AND event_type = N'session_start'
     ORDER BY ts ASC`,
    [projectId, sessionId],
  );
  const row = rows[0];
  if (!row) return null;

  const parsed = parsePayload(row.payload);
  const event = parsed?.type === "session_start" ? parsed : undefined;
  return {
    sessionId,
    // The client renders `datetime2` as naive-UTC text (`YYYY-MM-DD HH:MM:SS`).
    startedAt: row.ts,
    device: event?.device,
    scene: event?.scene,
    user: event?.user,
  };
}
