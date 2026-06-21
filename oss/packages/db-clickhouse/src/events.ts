import { nodeSampleRowToEvent, toEventRow, toNodeSampleRow, type SessionMeta } from "@uptimizr/db";
import { anyEventSchema, type AnyEvent, type NodeTransformEvent } from "@uptimizr/schema";
import type { ClickhouseClient } from "./client.js";

export type { SessionMeta };

/**
 * Batched insert of validated events. Reuses the shared {@link toEventRow} mapper
 * so the promoted columns match the DuckDB store exactly; rows are written via
 * `JSONEachRow`, with `ts` bound as the naive-UTC literal both engines accept.
 *
 * `node_transform` events (ADR 0027) are split out into the dedicated
 * `node_samples` table rather than the wide `events` table. Both inserts are
 * issued for the same batch; ClickHouse inserts are atomic per block, so each
 * table sees a consistent slice.
 */
export async function insertEvents(
  client: ClickhouseClient,
  events: readonly AnyEvent[],
): Promise<void> {
  if (events.length === 0) return;

  const wideRows: Record<string, unknown>[] = [];
  const nodeRows: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.type === "node_transform") {
      const row = toNodeSampleRow(event as NodeTransformEvent);
      nodeRows.push({
        project_id: row.project_id,
        session_id: row.session_id,
        ts: row.ts,
        sdk_version: row.sdk_version,
        scene_id: row.scene_id,
        node_id: row.node_id,
        bone_id: row.bone_id,
        position: row.position,
        rotation: row.rotation,
        scale: row.scale,
        child_path: row.child_path,
      });
    } else {
      const row = toEventRow(event);
      // Drop the engine-defaulted `inserted_at`; every other field maps 1:1 to a
      // column (JSONEachRow fills omitted columns from their DEFAULT).
      wideRows.push({
        project_id: row.project_id,
        session_id: row.session_id,
        visitor_id: row.visitor_id,
        event_type: row.event_type,
        ts: row.ts,
        sdk_version: row.sdk_version,
        url: row.url,
        scene_id: row.scene_id,
        source: row.source,
        handedness: row.handedness,
        source_id: row.source_id,
        ray_origin: row.ray_origin,
        ray_direction: row.ray_direction,
        position: row.position,
        direction: row.direction,
        hit_point: row.hit_point,
        screen: row.screen,
        mesh: row.mesh,
        fps: row.fps,
        visible_ms: row.visible_ms,
        centered_ms: row.centered_ms,
        screen_fraction: row.screen_fraction,
        texture_bytes: row.texture_bytes,
        geometry_bytes: row.geometry_bytes,
        triangles: row.triangles,
        vertices: row.vertices,
        js_heap_bytes: row.js_heap_bytes,
        cap_from: row.cap_from,
        cap_to: row.cap_to,
        frame_time_ms: row.frame_time_ms,
        frame_time_p95_ms: row.frame_time_p95_ms,
        long_frames: row.long_frames,
        dpr: row.dpr,
        render_scale: row.render_scale,
        name: row.name,
        payload: row.payload,
      });
    }
  }

  if (wideRows.length > 0) await client.insert("events", wideRows);
  if (nodeRows.length > 0) await client.insert("node_samples", nodeRows);
}

/** Raw `node_samples` row shape as read back from ClickHouse. */
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
  client: ClickhouseClient,
  projectId: string,
  sessionId: string,
): Promise<NodeTransformEvent[]> {
  const rows = await client.query<NodeSampleReadRow>(
    `SELECT toUnixTimestamp64Milli(ts) AS ts_ms, sdk_version, scene_id, node_id, bone_id,
            child_path, position, rotation, scale
     FROM node_samples
     WHERE project_id = {projectId:String} AND session_id = {sessionId:String}
     ORDER BY ts ASC`,
    { projectId, sessionId },
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

async function readSessionWideEvents(
  client: ClickhouseClient,
  projectId: string,
  sessionId: string,
): Promise<AnyEvent[]> {
  const rows = await client.query<{ payload: string }>(
    `SELECT payload FROM events
     WHERE project_id = {projectId:String} AND session_id = {sessionId:String}
     ORDER BY ts ASC`,
    { projectId, sessionId },
  );
  const events: AnyEvent[] = [];
  for (const row of rows) {
    const parsed = anyEventSchema.safeParse(JSON.parse(row.payload));
    if (parsed.success) events.push(parsed.data);
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
  client: ClickhouseClient,
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
 * response, ADR 0015). ClickHouse returns the session in one ordered result set;
 * node samples are merged in by `ts` before yielding.
 */
export async function* streamSessionEvents(
  client: ClickhouseClient,
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
  client: ClickhouseClient,
  projectId: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const rows = await client.query<{ payload: string; ts: string }>(
    `SELECT payload, toString(ts) AS ts FROM events
     WHERE project_id = {projectId:String} AND session_id = {sessionId:String}
       AND event_type = 'session_start'
     ORDER BY ts ASC
     LIMIT 1`,
    { projectId, sessionId },
  );
  const row = rows[0];
  if (!row) return null;

  const parsed = anyEventSchema.safeParse(JSON.parse(row.payload));
  const event = parsed.success && parsed.data.type === "session_start" ? parsed.data : undefined;
  return {
    sessionId,
    startedAt: row.ts,
    device: event?.device,
    scene: event?.scene,
    user: event?.user,
  };
}
