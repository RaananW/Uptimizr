/**
 * Engine-neutral event-row mapping (ADR 0020).
 *
 * `toEventRow` flattens a validated event into the wide column set both storage
 * engines share — DuckDB (OSS) and the single-tenant ClickHouse adapter (scale
 * tier). Keeping it here, free of any engine client, lets both stores
 * reuse one mapping and lets OSS carry zero ClickHouse references.
 */

import {
  DEFAULT_SCENE_ID,
  type AnyEvent,
  type Device,
  type NodeTransformEvent,
  type SceneMeta,
  type SessionUser,
} from "@uptimizr/schema";

/** Flat row matching the wide `events` table columns (engine-independent). */
export interface EventRow {
  project_id: string;
  session_id: string;
  visitor_id: string;
  event_type: string;
  ts: string;
  sdk_version: string;
  url: string;
  scene_id: string;
  source: string;
  handedness: string;
  source_id: string;
  ray_origin: number[];
  ray_direction: number[];
  position: number[];
  direction: number[];
  hit_point: number[];
  screen: number[];
  mesh: string;
  fps: number;
  visible_ms: number;
  centered_ms: number;
  screen_fraction: number;
  texture_bytes: number;
  geometry_bytes: number;
  triangles: number;
  vertices: number;
  js_heap_bytes: number;
  cap_from: string;
  cap_to: string;
  // frame_perf detail (#80): percentile/jank/resolution fields promoted from the
  // payload so the per-session perf percentile aggregations stay column-fast.
  frame_time_ms: number;
  frame_time_p95_ms: number;
  long_frames: number;
  dpr: number;
  render_scale: number;
  name: string;
  payload: string;
}

/**
 * Format an epoch-millisecond timestamp as a naive-UTC `YYYY-MM-DD HH:MM:SS.mmm`
 * literal. This is the timestamp form both engines accept (ClickHouse
 * `DateTime64(3)` and DuckDB `TIMESTAMP`), avoiding seconds/millis ambiguity.
 */
export function formatUtcTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

function vec(value: unknown): number[] {
  return Array.isArray(value) && value.every((n) => typeof n === "number")
    ? (value as number[])
    : [];
}

/**
 * Map a validated event into a flat row. Hot, queryable fields are promoted into
 * dedicated columns for aggregation; the full event is preserved in `payload`
 * (JSON) so reads remain replay-complete regardless of extraction.
 */
export function toEventRow(event: AnyEvent): EventRow {
  // The discriminated union widens awkwardly across payload variants; read
  // optional fields through a permissive view without losing the validated input.
  const e = event as AnyEvent & Record<string, unknown>;

  const hitPoint = vec(e.hitPoint).length ? vec(e.hitPoint) : vec(e.point);
  const mesh = typeof e.mesh === "string" ? e.mesh : typeof e.hitMesh === "string" ? e.hitMesh : "";
  // `name` carries the custom-event name / asset name, and is reused as the coarse
  // `phase` label for compile_stall (#42) and the `kind` label for
  // capability_change (#49) so those rollups can group without a dedicated column.
  const name =
    typeof e.name === "string"
      ? e.name
      : typeof e.phase === "string"
        ? e.phase
        : typeof e.kind === "string"
          ? e.kind
          : "";
  const ray = (e.ray ?? {}) as { origin?: unknown; direction?: unknown };

  return {
    project_id: event.projectId,
    session_id: event.sessionId,
    visitor_id: event.visitorId ?? "",
    event_type: event.type,
    ts: formatUtcTimestamp(event.ts),
    sdk_version: event.sdkVersion,
    url: event.url ?? "",
    scene_id: typeof e.sceneId === "string" && e.sceneId.length > 0 ? e.sceneId : DEFAULT_SCENE_ID,
    source: typeof e.source === "string" && e.source.length > 0 ? e.source : "mouse",
    handedness: typeof e.handedness === "string" ? e.handedness : "",
    source_id: typeof e.sourceId === "string" ? e.sourceId : "",
    ray_origin: vec(ray.origin),
    ray_direction: vec(ray.direction),
    position: vec(e.position),
    direction: vec(e.direction),
    hit_point: hitPoint,
    screen: vec(e.screen),
    mesh,
    fps: typeof e.fps === "number" ? e.fps : 0,
    // mesh_visibility dwell metrics (#37): promoted for the object-attention
    // aggregation; 0 on every other event type (the full event stays in payload).
    // hover_dwell (#48) reuses this column for its `dwellMs` duration, and
    // compile_stall (#42) reuses it for its `durationMs` — all are millisecond
    // durations, so no extra column/migration is needed.
    visible_ms:
      typeof e.visibleMs === "number"
        ? e.visibleMs
        : typeof e.dwellMs === "number"
          ? e.dwellMs
          : typeof e.durationMs === "number"
            ? e.durationMs
            : 0,
    centered_ms: typeof e.centeredMs === "number" ? e.centeredMs : 0,
    screen_fraction: typeof e.maxScreenFraction === "number" ? e.maxScreenFraction : 0,
    // resource_sample (#44) GPU / memory footprint metrics; 0 on other event
    // types (the full event stays in payload). Every field is optional on the
    // event, so undefined maps to 0 (NULL-equivalent for SUM/AVG/MAX).
    texture_bytes: typeof e.textureBytes === "number" ? e.textureBytes : 0,
    geometry_bytes: typeof e.geometryBytes === "number" ? e.geometryBytes : 0,
    triangles: typeof e.triangles === "number" ? e.triangles : 0,
    vertices: typeof e.vertices === "number" ? e.vertices : 0,
    js_heap_bytes: typeof e.jsHeapBytes === "number" ? e.jsHeapBytes : 0,
    // capability_change (#49) transition tokens; '' on other event types (the
    // full event, including `reason`, stays in payload). `kind` lives in `name`.
    cap_from: typeof e.from === "string" ? e.from : "",
    cap_to: typeof e.to === "string" ? e.to : "",
    // frame_perf (#80) percentile/jank/resolution detail; 0 on other event types
    // (the full event stays in payload). All are optional on the event, so an
    // absent field maps to 0 — perf queries filter `event_type = 'frame_perf'`
    // and use `nullIf(...)` where 0 is not a meaningful sample (dpr/renderScale).
    frame_time_ms: typeof e.frameTimeMs === "number" ? e.frameTimeMs : 0,
    frame_time_p95_ms: typeof e.frameTimeP95Ms === "number" ? e.frameTimeP95Ms : 0,
    long_frames: typeof e.longFrames === "number" ? e.longFrames : 0,
    dpr: typeof e.dpr === "number" ? e.dpr : 0,
    render_scale: typeof e.renderScale === "number" ? e.renderScale : 0,
    name,
    payload: JSON.stringify(event),
  };
}

/** Per-session descriptor extracted from the session's `session_start` event. */
export interface SessionMeta {
  sessionId: string;
  /** Session start time as a naive-UTC `YYYY-MM-DD HH:MM:SS.mmm` string, if known. */
  startedAt: string | undefined;
  device: Device | undefined;
  scene: SceneMeta | undefined;
  user: SessionUser | undefined;
}

/**
 * Flat row matching the dedicated `node_samples` table (ADR 0027 §9). The
 * `node_transform` event is split out of the wide `events` table: it is the
 * highest-cardinality signal in the system, so it gets its own transform-shaped
 * storage instead of padding `events` with quaternion/bone columns that are null
 * for every other type. `bone_id` is `''` for the Tier-1 node/root tier; `scale`
 * is `[]` when the sample omitted it (unchanged from identity / last sample).
 * `child_path` (ADR 0033) is `''` for the declared root and for bone rows; it is
 * the descendant's path relative to `node_id` for a Tier-1 subtree child.
 */
export interface NodeSampleRow {
  project_id: string;
  session_id: string;
  ts: string;
  sdk_version: string;
  scene_id: string;
  node_id: string;
  bone_id: string;
  child_path: string;
  position: number[];
  rotation: number[];
  scale: number[];
}

/** Map a validated `node_transform` event into a flat {@link NodeSampleRow}. */
export function toNodeSampleRow(event: NodeTransformEvent): NodeSampleRow {
  return {
    project_id: event.projectId,
    session_id: event.sessionId,
    ts: formatUtcTimestamp(event.ts),
    sdk_version: event.sdkVersion,
    scene_id:
      typeof event.sceneId === "string" && event.sceneId.length > 0
        ? event.sceneId
        : DEFAULT_SCENE_ID,
    node_id: event.nodeId,
    bone_id: event.boneId ?? "",
    child_path: event.childPath ?? "",
    position: [...event.position],
    rotation: [...event.rotation],
    scale: event.scale ? [...event.scale] : [],
  };
}

/**
 * Reconstruct a replay-complete `node_transform` event from a stored
 * {@link NodeSampleRow}. The dedicated table keeps only the transform-shaped
 * columns, so this rehydrates the schema event for the replay merge (ADR 0027
 * §8). `tsEpochMs` is the row's `ts` already converted back to epoch ms by the
 * caller (engine-specific timestamp decoding stays in the store).
 */
export function nodeSampleRowToEvent(
  row: Pick<
    NodeSampleRow,
    "project_id" | "session_id" | "sdk_version" | "scene_id" | "node_id" | "bone_id" | "child_path"
  > & { position: number[]; rotation: number[]; scale: number[] },
  tsEpochMs: number,
): NodeTransformEvent {
  const event: NodeTransformEvent = {
    type: "node_transform",
    projectId: row.project_id,
    sessionId: row.session_id,
    ts: tsEpochMs,
    sdkVersion: row.sdk_version,
    nodeId: row.node_id,
    position: row.position as [number, number, number],
    rotation: row.rotation as [number, number, number, number],
  };
  if (row.scene_id && row.scene_id !== DEFAULT_SCENE_ID) event.sceneId = row.scene_id;
  if (row.bone_id) event.boneId = row.bone_id;
  if (row.child_path) event.childPath = row.child_path;
  if (row.scale.length === 3) event.scale = row.scale as [number, number, number];
  return event;
}
