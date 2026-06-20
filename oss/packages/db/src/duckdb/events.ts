import { DOUBLE, LIST, timestampValue, type DuckDBConnection } from "@duckdb/node-api";
import { anyEventSchema, type AnyEvent, type NodeTransformEvent } from "@uptimizr/schema";
import { toEventRow, toNodeSampleRow, nodeSampleRowToEvent } from "../events.js";
import type { DuckdbClient } from "./client.js";
import type { SessionMeta } from "../events.js";

export type { SessionMeta };

/** Coerce an event's epoch-ms timestamp into a DuckDB TIMESTAMP value (UTC micros). */
function tsValue(epochMs: number): ReturnType<typeof timestampValue> {
  return timestampValue(BigInt(Math.trunc(epochMs)) * 1000n);
}

/**
 * Batched insert of validated events via the DuckDB Appender — the bulk path
 * that handles `DOUBLE[]` columns (including empty arrays) natively. Reuses the
 * shared {@link toEventRow} mapper so the promoted columns match the ClickHouse
 * store exactly; only `ts`/`inserted_at` are bound as native TIMESTAMP values.
 *
 * `node_transform` events (ADR 0027) are split out into the dedicated
 * `node_samples` table rather than the wide `events` table; both writes happen
 * under the same single-writer lock so a batch is never partially applied.
 *
 * Runs under the client's single-writer lock so the append is never interleaved
 * with another statement.
 */
export async function insertEvents(
  client: DuckdbClient,
  events: readonly AnyEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const wideEvents = events.filter((e) => e.type !== "node_transform");
  const nodeSamples = events.filter((e): e is NodeTransformEvent => e.type === "node_transform");
  await client.exclusive(async (con: DuckDBConnection) => {
    const now = tsValue(Date.now());
    if (wideEvents.length > 0) {
      const appender = await con.createAppender("events");
      for (const event of wideEvents) {
        const row = toEventRow(event);
        appender.appendVarchar(row.project_id);
        appender.appendVarchar(row.session_id);
        appender.appendVarchar(row.visitor_id);
        appender.appendVarchar(row.event_type);
        appender.appendTimestamp(tsValue(event.ts));
        appender.appendVarchar(row.sdk_version);
        appender.appendVarchar(row.url);
        appender.appendVarchar(row.scene_id);
        appender.appendVarchar(row.source);
        appender.appendVarchar(row.handedness);
        appender.appendVarchar(row.source_id);
        appender.appendList(row.ray_origin, LIST(DOUBLE));
        appender.appendList(row.ray_direction, LIST(DOUBLE));
        appender.appendList(row.position, LIST(DOUBLE));
        appender.appendList(row.direction, LIST(DOUBLE));
        appender.appendList(row.hit_point, LIST(DOUBLE));
        appender.appendList(row.screen, LIST(DOUBLE));
        appender.appendVarchar(row.mesh);
        appender.appendDouble(row.fps);
        appender.appendVarchar(row.name);
        appender.appendVarchar(row.payload);
        appender.appendTimestamp(now);
        // Columns added by later ALTER TABLE migrations are physically appended
        // after `inserted_at`, so the mesh_visibility metrics (#37, migrations
        // 0008–0010) are appended here, last, to match the table's column order.
        appender.appendDouble(row.visible_ms);
        appender.appendDouble(row.centered_ms);
        appender.appendDouble(row.screen_fraction);
        // resource_sample footprint columns (#44, migrations 0011–0015) follow,
        // in table column order.
        appender.appendDouble(row.texture_bytes);
        appender.appendDouble(row.geometry_bytes);
        appender.appendDouble(row.triangles);
        appender.appendDouble(row.vertices);
        appender.appendDouble(row.js_heap_bytes);
        // capability_change tokens (#49, migrations 0016–0017) follow, in table
        // column order. `kind` is carried by `name` above.
        appender.appendVarchar(row.cap_from);
        appender.appendVarchar(row.cap_to);
        // frame_perf detail columns (#80, migrations 0020–0024) follow, in table
        // column order. 0 on non-frame_perf rows (filtered out on read).
        appender.appendDouble(row.frame_time_ms);
        appender.appendDouble(row.frame_time_p95_ms);
        appender.appendDouble(row.long_frames);
        appender.appendDouble(row.dpr);
        appender.appendDouble(row.render_scale);
        appender.endRow();
      }
      appender.flushSync();
      appender.closeSync();
    }
    if (nodeSamples.length > 0) {
      // node_samples (ADR 0027 §9): transform-shaped table, column order matches
      // migration 0018 — project, session, ts, sdk_version, scene_id, node_id,
      // bone_id, position, rotation, scale, inserted_at. `child_path` (ADR 0033,
      // migration 0025) is physically last, so it is appended after inserted_at.
      const appender = await con.createAppender("node_samples");
      for (const event of nodeSamples) {
        const row = toNodeSampleRow(event);
        appender.appendVarchar(row.project_id);
        appender.appendVarchar(row.session_id);
        appender.appendTimestamp(tsValue(event.ts));
        appender.appendVarchar(row.sdk_version);
        appender.appendVarchar(row.scene_id);
        appender.appendVarchar(row.node_id);
        appender.appendVarchar(row.bone_id);
        appender.appendList(row.position, LIST(DOUBLE));
        appender.appendList(row.rotation, LIST(DOUBLE));
        appender.appendList(row.scale, LIST(DOUBLE));
        appender.appendTimestamp(now);
        appender.appendVarchar(row.child_path);
        appender.endRow();
      }
      appender.flushSync();
      appender.closeSync();
    }
  });
}

/** Raw `node_samples` row shape as read back from DuckDB. */
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
 * into replay-complete events in `ts` order. Split from {@link getSessionEvents}
 * because they live in a dedicated table; the two ordered streams are merged by
 * the callers below.
 */
async function readSessionNodeSamples(
  client: DuckdbClient,
  projectId: string,
  sessionId: string,
): Promise<NodeTransformEvent[]> {
  const rows = await client.all<NodeSampleReadRow>(
    `SELECT epoch_ms(ts) AS ts_ms, sdk_version, scene_id, node_id, bone_id,
            child_path, position, rotation, scale
     FROM node_samples
     WHERE project_id = $projectId AND session_id = $sessionId
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
 * Merge two `ts`-ordered event streams into one ascending stream. Stable on
 * ties (wide events before node samples at the same `ts`), so replay sees a
 * single ordered timeline (ADR 0027 §8).
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
 * Ordered read of a single session's events for replay/timeline. Returns
 * fully-parsed, schema-validated events in `ts` order. Gated upstream by
 * `ENABLE_RAW_SESSION_RETENTION` (ADR 0003) — this function does not enforce it.
 *
 * Merges the wide `events` table with the dedicated `node_samples` table
 * (ADR 0027 §9) so scene-actor motion replays alongside the visitor's inputs.
 */
export async function getSessionEvents(
  client: DuckdbClient,
  projectId: string,
  sessionId: string,
): Promise<AnyEvent[]> {
  const rows = await client.all<{ payload: string }>(
    `SELECT payload FROM events
     WHERE project_id = $projectId AND session_id = $sessionId
     ORDER BY ts ASC`,
    { projectId, sessionId },
  );
  const events: AnyEvent[] = [];
  for (const row of rows) {
    const parsed = anyEventSchema.safeParse(JSON.parse(row.payload));
    if (parsed.success) events.push(parsed.data);
  }
  const nodes = await readSessionNodeSamples(client, projectId, sessionId);
  return nodes.length > 0 ? mergeByTs(events, nodes) : events;
}

/**
 * Streaming counterpart to {@link getSessionEvents}: yields one validated event
 * at a time in `ts` order. For the self-hosted single-file store a session is
 * read in order and yielded incrementally; malformed/invalid rows are skipped.
 * This is the path behind the collector's NDJSON replay response (ADR 0015).
 *
 * Includes reconstructed `node_samples` (ADR 0027), merged into the wide-event
 * stream by `ts` so the replay timeline stays complete and ordered.
 */
export async function* streamSessionEvents(
  client: DuckdbClient,
  projectId: string,
  sessionId: string,
): AsyncGenerator<AnyEvent> {
  const rows = await client.all<{ payload: string }>(
    `SELECT payload FROM events
     WHERE project_id = $projectId AND session_id = $sessionId
     ORDER BY ts ASC`,
    { projectId, sessionId },
  );
  const wide: AnyEvent[] = [];
  for (const row of rows) {
    const parsed = anyEventSchema.safeParse(JSON.parse(row.payload));
    if (parsed.success) wide.push(parsed.data);
  }
  const nodes = await readSessionNodeSamples(client, projectId, sessionId);
  const ordered = nodes.length > 0 ? mergeByTs(wide, nodes) : wide;
  for (const event of ordered) yield event;
}

/**
 * Read a session's stored metadata (`device`/`scene`/`user`) from its
 * `session_start` event. Returns `null` when the session has no start event.
 * Coarse descriptor — not gated by raw-session retention.
 */
export async function getSessionMeta(
  client: DuckdbClient,
  projectId: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const rows = await client.all<{ payload: string; ts: string }>(
    `SELECT payload, CAST(ts AS VARCHAR) AS ts FROM events
     WHERE project_id = $projectId AND session_id = $sessionId
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
