import type { Vec3 } from "@uptimizr/schema";

import type { CameraGestureSample, GestureClassifyOptions } from "../gesture.js";
import type { CameraPose, NodeSample } from "./math.js";

/**
 * Internal **snapshot DTOs** for the connector-side offload seam (ADR 0031
 * follow-up, #10).
 *
 * These are the plain-data records a connector produces on the main thread after
 * reading live engine state (the cheap "snapshot" phase) and hands to the
 * {@link Aggregator} (the offload-eligible "processing" phase). They are an
 * **internal SDK transport contract** — they never reach the wire, so they are
 * deliberately *not* part of `@uptimizr/schema` (the wire contract stays
 * unchanged; ADR 0031 §7, ADR 0003). The aggregator consumes them and produces
 * the Zod-shaped `@uptimizr/schema` events.
 *
 * The boundary is kept clean: no engine or DOM handle crosses it, only numbers,
 * ids and timestamps. High-volume channels (the frame-time window, node/bone
 * matrices) are typed-array-backed so they can move to a worker zero-copy via
 * the transferable mechanism (#98).
 */

/** A camera pose + optional gaze hit. The connector has already idle-gated this. */
export interface CameraSnapshot {
  channel: "camera";
  position: Vec3;
  direction: Vec3;
  target?: Vec3;
  fov?: number;
  /** Surface hit of the forward gaze ray, when gaze capture is on (ADR 0030). */
  hitPoint?: Vec3;
  hitMesh?: string;
}

/**
 * A frame-time window plus the engine perf reads taken at finalize time. The
 * percentile sort, `longFrames` count and FPS idle-diff move to the aggregator.
 * `frameTimes` is a fresh, owned `Float32Array` so it can be transferred.
 */
export interface PerfSnapshot {
  channel: "perf";
  /** Per-frame deltas (ms) collected since the previous perf sample. */
  frameTimes: Float32Array;
  fps: number;
  /** Frames slower than this (ms) count as `longFrames`. */
  jankFrameMs: number;
  dpr?: number;
  renderScale?: number;
}

/**
 * A node/bone transform snapshot. Either already-decomposed (engines that expose
 * an absolute position/quaternion/scale, e.g. Babylon world nodes) or a raw
 * column-major matrix (bones, three.js world matrices) the aggregator decomposes.
 * Idle-diffing is keyed by `(nodeId, childPath ?? boneId)` and runs aggregator-side.
 */
export interface NodeSnapshot {
  channel: "node";
  nodeId: string;
  childPath?: string;
  boneId?: string;
  /** Pre-decomposed transform (mutually exclusive with {@link matrix}). */
  decomposed?: NodeSample;
  /** Column-major 16-float world/local matrix to decompose (transferable-backed). */
  matrix?: Float32Array;
  /** Scale dead-zone: scale within `scaleEps` of identity is omitted. */
  scaleEps: number;
}

/** One mesh's per-tick visibility observation (engine reads already taken). */
export interface VisibilityMeshObservation {
  mesh: string;
  center: Vec3;
  radius: number;
  /** World AABB `[minX,minY,minZ,maxX,maxY,maxZ]`, when bounds capture is on (#53). */
  aabb?: [number, number, number, number, number, number];
}

/** A single render-tick of mesh-visibility observations (#37). */
export interface VisibilityTickSnapshot {
  channel: "visibilityTick";
  /** Elapsed time of this tick in ms (the dwell increment). */
  stepMs: number;
  camPos: Vec3;
  forward: Vec3;
  /** Camera vertical FOV in radians (used for the screen-fraction proxy). */
  fov: number;
  meshes: VisibilityMeshObservation[];
}

/** Finalize the current mesh-visibility window: emit one summary per object. */
export interface VisibilityFlushSnapshot {
  channel: "visibilityFlush";
}

/** A camera-gesture bracket (start→end) to classify (ADR 0025). */
export interface GestureSnapshot {
  channel: "gesture";
  start: CameraGestureSample;
  end: CameraGestureSample;
  /** Length of the input bracket (`down → up`) in ms, measured on the main thread. */
  durationMs: number;
  options?: GestureClassifyOptions;
  /** Discrete input source that bracketed the gesture (ADR 0023), when known. */
  source?: string;
}

/** A completed hover episode past its dwell threshold (#48). */
export interface HoverSnapshot {
  channel: "hover";
  mesh: string;
  dwellMs: number;
  source?: string;
}

/** The union the aggregator ingests. */
export type Snapshot =
  | CameraSnapshot
  | PerfSnapshot
  | NodeSnapshot
  | VisibilityTickSnapshot
  | VisibilityFlushSnapshot
  | GestureSnapshot
  | HoverSnapshot;

/** Channel discriminator for a {@link Snapshot}. */
export type SnapshotChannel = Snapshot["channel"];

/** Re-export so callers can type the camera idle-diff pre-gate against it. */
export type { CameraPose };

/**
 * Collect the transferable buffers a snapshot carries so they move to the worker
 * zero-copy (ADR 0031 §6, #98). Transferring neuters the buffer on the main
 * thread, so a snapshot that opts in must own a fresh buffer; the aggregator's
 * default (main) path never transfers, so the buffer stays usable there.
 */
export function collectSnapshotTransferables(snapshot: Snapshot): Transferable[] {
  if (snapshot.channel === "perf") {
    return [snapshot.frameTimes.buffer];
  }
  if (snapshot.channel === "node" && snapshot.matrix) {
    return [snapshot.matrix.buffer];
  }
  return [];
}
