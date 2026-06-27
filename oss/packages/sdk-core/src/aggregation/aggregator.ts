import type { Aabb } from "@uptimizr/schema";

import { classifyCameraGesture } from "../gesture.js";
import { decomposeWorldMatrix } from "../matrix.js";
import type { EventInput } from "../types.js";
import {
  aabbClose,
  nodeSampleUnchanged,
  percentileAsc,
  roundAabb,
  visibilityContribution,
  length3,
  type NodeSample,
} from "./math.js";
import type { NodeSnapshot, PerfSnapshot, Snapshot, VisibilityTickSnapshot } from "./snapshot.js";

/**
 * Serializable per-channel configuration for the {@link Aggregator}, mirroring the
 * connector's resolved capture config. It holds only plain data (no callbacks or
 * handles) so it can be `postMessage`d to the offload worker unchanged. Passed
 * once at construction so per-frame snapshots stay lean.
 */
export interface AggregatorConfig {
  /** Frame-perf channel knobs (#41). */
  perf?: {
    /** Suppress a perf sample whose FPS is within `fpsThreshold` of the last. */
    suppressIdle: boolean;
    /** FPS dead-zone for idle suppression. */
    fpsThreshold: number;
  };
  /** Node/bone transform channel knobs (ADR 0027). */
  node?: {
    /** Suppress a transform sample unchanged from the last within its epsilon. */
    suppressIdle: boolean;
  };
  /** Mesh-visibility channel knobs (#37, ADR 0012). */
  visibility?: {
    /** Cosine of the centred half-angle (`centeredMs` gate). */
    centeredCos: number;
    /** Whether to ride along world AABBs (#53). */
    boundingBox: boolean;
    /** AABB change dead-zone before a bounds re-send. */
    boundsEps: number;
  };
}

/**
 * {@link Aggregator} construction options: the serializable {@link AggregatorConfig}
 * plus the (non-serializable) sink for finalized events. In main mode the sink is
 * the client `emit`; in the worker it buffers events to post back to the page.
 */
export interface AggregatorOptions extends AggregatorConfig {
  /** Sink for finalized events. In main mode this is the client `emit`. */
  emit: (event: EventInput) => void;
}

/** Per-object dwell accumulator over the current `mesh_visibility` window (#37). */
interface VisibilityAccumulator {
  visibleMs: number;
  centeredMs: number;
  maxScreenFraction: number;
  bounds?: Aabb;
}

/**
 * The engine-agnostic **Aggregator** (ADR 0031 follow-up, #10): the single home
 * for the offload-eligible *processing* phase of per-frame capture. It consumes
 * the connectors' plain-number {@link Snapshot} DTOs and produces finalized
 * `@uptimizr/schema` events — running the frame-time percentiles, matrix
 * decomposition, mesh-visibility bucketing, idle-diffing and gesture
 * classification that used to live, duplicated, inside each connector.
 *
 * It holds no engine or DOM handle, so the *same instance logic* runs unchanged
 * on the main thread (default) or inside the offload worker (opt-in). All math is
 * the shared, isomorphic functions from {@link ./math.js}, {@link ../matrix.js}
 * and {@link ../gesture.js} — there is no worker-only fork (ADR 0031 §2).
 */
export interface Aggregator {
  /** Ingest one snapshot, emitting any resulting finalized events synchronously. */
  ingest(snapshot: Snapshot): void;
  /** Reset all per-channel windowed state (e.g. between sessions). Idempotent. */
  reset(): void;
}

/** Create an {@link Aggregator}. */
export function createAggregator(options: AggregatorOptions): Aggregator {
  const emit = options.emit;

  // --- frame_perf state ---
  let lastFps: number | undefined;

  // --- node_transform state (keyed by nodeId\0(childPath|boneId)) ---
  const lastNodeSample = new Map<string, NodeSample>();

  // --- mesh_visibility window state ---
  let accums = new Map<string, VisibilityAccumulator>();
  const sentBounds = new Map<string, Aabb>();

  function handlePerf(s: PerfSnapshot): void {
    const window = s.frameTimes;
    let percentiles:
      | { frameTimeP95Ms: number; frameTimeP99Ms: number; longFrames: number }
      | undefined;
    if (window.length > 0) {
      let longFrames = 0;
      for (let i = 0; i < window.length; i++) {
        if ((window[i] as number) > s.jankFrameMs) longFrames++;
      }
      const sorted = Array.from(window).sort((a, b) => a - b);
      percentiles = {
        frameTimeP95Ms: percentileAsc(sorted, 95),
        frameTimeP99Ms: percentileAsc(sorted, 99),
        longFrames,
      };
    }
    const suppress = options.perf?.suppressIdle ?? false;
    const threshold = options.perf?.fpsThreshold ?? 0;
    if (suppress && lastFps !== undefined && Math.abs(s.fps - lastFps) <= threshold) {
      return;
    }
    lastFps = s.fps;
    emit({
      type: "frame_perf",
      fps: s.fps,
      ...(percentiles ?? {}),
      ...(typeof s.dpr === "number" && s.dpr > 0 ? { dpr: s.dpr } : {}),
      ...(s.renderScale !== undefined ? { renderScale: s.renderScale } : {}),
    } as EventInput);
  }

  function handleNode(s: NodeSnapshot): void {
    const sample: NodeSample = s.decomposed ?? decomposeNode(s.matrix, s.scaleEps);
    const key = s.boneId
      ? `${s.nodeId}\u0000bone\u0000${s.boneId}`
      : s.childPath !== undefined
        ? `${s.nodeId}\u0000${s.childPath}`
        : s.nodeId;
    const suppress = options.node?.suppressIdle ?? false;
    const prev = lastNodeSample.get(key);
    if (suppress && prev && nodeSampleUnchanged(prev, sample, s.scaleEps)) {
      return;
    }
    lastNodeSample.set(key, sample);
    emit({
      type: "node_transform",
      nodeId: s.nodeId,
      ...(s.childPath !== undefined ? { childPath: s.childPath } : {}),
      ...(s.boneId !== undefined ? { boneId: s.boneId } : {}),
      position: sample.position,
      rotation: sample.rotation,
      ...(sample.scale ? { scale: sample.scale } : {}),
    } as EventInput);
  }

  function handleVisibilityTick(s: VisibilityTickSnapshot): void {
    if (s.stepMs <= 0) return;
    const centeredCos = options.visibility?.centeredCos ?? 1;
    const boundingBox = options.visibility?.boundingBox ?? false;
    const fwdLen = length3(s.forward) || 1;
    const halfFov = (s.fov || 0.8) / 2;
    for (const obs of s.meshes) {
      const { centered, frac } = visibilityContribution(
        s.camPos,
        s.forward,
        fwdLen,
        halfFov,
        obs.center,
        obs.radius,
        centeredCos,
      );
      let acc = accums.get(obs.mesh);
      if (!acc) {
        acc = { visibleMs: 0, centeredMs: 0, maxScreenFraction: 0 };
        accums.set(obs.mesh, acc);
      }
      acc.visibleMs += s.stepMs;
      if (centered) acc.centeredMs += s.stepMs;
      if (frac > acc.maxScreenFraction) acc.maxScreenFraction = frac;
      if (boundingBox && obs.aabb) acc.bounds = obs.aabb;
    }
  }

  function handleVisibilityFlush(): void {
    if (accums.size === 0) return;
    const boundsEps = options.visibility?.boundsEps ?? 1e-3;
    const pending = accums;
    accums = new Map<string, VisibilityAccumulator>();
    for (const [mesh, acc] of pending) {
      if (acc.visibleMs <= 0) continue;
      let bounds: Aabb | undefined;
      if (acc.bounds) {
        const prev = sentBounds.get(mesh);
        if (!prev || !aabbClose(prev, acc.bounds, boundsEps)) {
          bounds = roundAabb(acc.bounds);
          sentBounds.set(mesh, acc.bounds);
        }
      }
      emit({
        type: "mesh_visibility",
        mesh,
        visibleMs: Math.round(acc.visibleMs),
        ...(acc.centeredMs > 0 ? { centeredMs: Math.round(acc.centeredMs) } : {}),
        ...(acc.maxScreenFraction > 0
          ? { maxScreenFraction: Math.round(acc.maxScreenFraction * 1e4) / 1e4 }
          : {}),
        ...(bounds ? { bounds } : {}),
      } as EventInput);
    }
  }

  return {
    ingest(snapshot: Snapshot): void {
      switch (snapshot.channel) {
        case "camera":
          emit({
            type: "camera_sample",
            position: snapshot.position,
            direction: snapshot.direction,
            ...(snapshot.target ? { target: snapshot.target } : {}),
            ...(snapshot.fov !== undefined ? { fov: snapshot.fov } : {}),
            ...(snapshot.aspect !== undefined ? { aspect: snapshot.aspect } : {}),
            ...(snapshot.near !== undefined ? { near: snapshot.near } : {}),
            ...(snapshot.hitPoint ? { hitPoint: snapshot.hitPoint } : {}),
            ...(snapshot.hitMesh ? { hitMesh: snapshot.hitMesh } : {}),
          } as EventInput);
          return;
        case "perf":
          handlePerf(snapshot);
          return;
        case "node":
          handleNode(snapshot);
          return;
        case "visibilityTick":
          handleVisibilityTick(snapshot);
          return;
        case "visibilityFlush":
          handleVisibilityFlush();
          return;
        case "gesture": {
          const classified = classifyCameraGesture(
            snapshot.start,
            snapshot.end,
            snapshot.options ?? {},
          );
          if (!classified) return;
          emit({
            type: "camera_gesture",
            kind: classified.kind,
            durationMs: snapshot.durationMs,
            ...(classified.orbitDeg !== undefined ? { orbitDeg: classified.orbitDeg } : {}),
            ...(classified.rollDeg !== undefined ? { rollDeg: classified.rollDeg } : {}),
            ...(classified.zoomRatio !== undefined ? { zoomRatio: classified.zoomRatio } : {}),
            ...(classified.panDist !== undefined ? { panDist: classified.panDist } : {}),
            ...(snapshot.source ? { source: snapshot.source } : {}),
          } as EventInput);
          return;
        }
        case "hover":
          emit({
            type: "hover_dwell",
            mesh: snapshot.mesh,
            dwellMs: snapshot.dwellMs,
            ...(snapshot.source ? { source: snapshot.source } : {}),
          } as EventInput);
          return;
      }
    },
    reset(): void {
      lastFps = undefined;
      lastNodeSample.clear();
      accums = new Map<string, VisibilityAccumulator>();
      sentBounds.clear();
    },
  };
}

/** Decompose a 16-float column-major matrix into a node sample (scale omitted if identity). */
function decomposeNode(matrix: Float32Array | undefined, scaleEps: number): NodeSample {
  if (!matrix || matrix.length < 16) {
    return { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
  }
  const d = decomposeWorldMatrix(matrix);
  const sample: NodeSample = { position: d.position, rotation: d.rotation };
  const [sx, sy, sz] = d.scale;
  if (Math.abs(sx - 1) > scaleEps || Math.abs(sy - 1) > scaleEps || Math.abs(sz - 1) > scaleEps) {
    sample.scale = d.scale;
  }
  return sample;
}
