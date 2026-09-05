import {
  nodeSampleRowToEvent,
  toEventRow,
  toNodeSampleRow,
  type EventRow,
  type NodeSampleRow,
  type SessionMeta,
} from "@uptimizr/db";
import { anyEventSchema, type AnyEvent, type NodeTransformEvent } from "@uptimizr/schema";
import type { PostgresClient, PostgresExecutor } from "./client.js";

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
 * Rows per multi-row `INSERT`. Postgres caps a statement at 65535 bound
 * parameters; 39 columns × 500 rows stays well under it.
 */
const INSERT_CHUNK_ROWS = 500;

/**
 * Multi-row `INSERT INTO table (cols) VALUES ($1,…),($n,…)` in chunks. Column
 * types are taken from the target table, so `pg`'s text encoding of arrays
 * (`{1,2,3}`), timestamps (naive-UTC strings) and JSON needs no explicit casts.
 */
async function insertRows(
  tx: PostgresExecutor,
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_ROWS);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((col) => `$${values.push(row[col])}`);
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
 * so the promoted columns match the DuckDB store exactly; `ts` is bound as the
 * naive-UTC literal every engine accepts and `payload` lands in `jsonb`.
 *
 * `node_transform` events (ADR 0027) are split out into the dedicated
 * `node_samples` table rather than the wide `events` table. Both inserts run in
 * one transaction, so a batch is never partially applied.
 */
export async function insertEvents(
  client: PostgresClient,
  events: readonly AnyEvent[],
): Promise<void> {
  if (events.length === 0) return;

  const wideRows: Record<string, unknown>[] = [];
  const nodeRows: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.type === "node_transform") {
      nodeRows.push({ ...toNodeSampleRow(event as NodeTransformEvent) });
    } else {
      wideRows.push({ ...toEventRow(event) });
    }
  }

  await client.transaction(async (tx) => {
    if (wideRows.length > 0) await insertRows(tx, "events", EVENT_COLUMNS, wideRows);
    if (nodeRows.length > 0) await insertRows(tx, "node_samples", NODE_SAMPLE_COLUMNS, nodeRows);
  });
}

/** Raw `node_samples` row shape as read back from Postgres. */
interface NodeSampleReadRow {
  ts_ms: number;
  sdk_version: string;
  scene_id: string;
  node_id: string;
  bone_id: string;
  child_path: string;
  position: number[];
  rotation: number[];
  scale: number[];
}

/**
 * Read a session's stored `node_transform` samples (ADR 0027), reconstructed
 * into replay-complete events in `ts` order.
 */
async function readSessionNodeSamples(
  client: PostgresClient,
  projectId: string,
  sessionId: string,
): Promise<NodeTransformEvent[]> {
  const rows = await client.query<NodeSampleReadRow>(
    `SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms, sdk_version, scene_id, node_id,
            bone_id, child_path, position, rotation, scale
     FROM node_samples
     WHERE project_id = $1 AND session_id = $2
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
        position: row.position ?? [],
        rotation: row.rotation ?? [],
        scale: row.scale ?? [],
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

/**
 * `pg` parses `jsonb` columns into objects already; accept a JSON string too so
 * the mapper is robust to a `text`-typed projection.
 */
function parsePayload(payload: unknown): AnyEvent | undefined {
  const value = typeof payload === "string" ? JSON.parse(payload) : payload;
  const parsed = anyEventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function readSessionWideEvents(
  client: PostgresClient,
  projectId: string,
  sessionId: string,
): Promise<AnyEvent[]> {
  const rows = await client.query<{ payload: unknown }>(
    `SELECT payload FROM events
     WHERE project_id = $1 AND session_id = $2
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
  client: PostgresClient,
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
  client: PostgresClient,
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
  client: PostgresClient,
  projectId: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const rows = await client.query<{ payload: unknown; ts: string }>(
    `SELECT payload, CAST(ts AS TEXT) AS ts FROM events
     WHERE project_id = $1 AND session_id = $2
       AND event_type = 'session_start'
     ORDER BY ts ASC
     LIMIT 1`,
    [projectId, sessionId],
  );
  const row = rows[0];
  if (!row) return null;

  const parsed = parsePayload(row.payload);
  const event = parsed?.type === "session_start" ? parsed : undefined;
  return {
    sessionId,
    startedAt: row.ts,
    device: event?.device,
    scene: event?.scene,
    user: event?.user,
  };
}
