import { describe, it, expect, vi } from "vitest";
import { anyEventSchema } from "@uptimizr/schema";
import type { AnyEvent } from "@uptimizr/schema";

import { createAggregator } from "../aggregation/aggregator.js";
import type { Aggregator } from "../aggregation/aggregator.js";
import type { EventInput } from "../types.js";

/**
 * Validate that the engine-agnostic Aggregator (ADR 0031 follow-up, #10)
 * reproduces — byte-for-byte — the per-channel events the connectors used to emit
 * inline, for both the main-thread and (identical-logic) worker paths.
 */

function collect(): { agg: Aggregator; events: EventInput[] } {
  const events: EventInput[] = [];
  const agg = createAggregator({
    emit: (e) => events.push(e),
    perf: { suppressIdle: false, fpsThreshold: 1 },
    node: { suppressIdle: true },
    visibility: {
      centeredCos: Math.cos((12 * Math.PI) / 180),
      boundingBox: false,
      boundsEps: 1e-3,
    },
  });
  return { agg, events };
}

/** Every finalized event the aggregator emits must satisfy the wire schema (with an envelope). */
function expectValid(e: EventInput): void {
  const withEnvelope = {
    ...e,
    projectId: "p",
    sessionId: "s",
    ts: 1,
    sdkVersion: "0.0.0",
  } as AnyEvent;
  expect(anyEventSchema.safeParse(withEnvelope).success).toBe(true);
}

describe("aggregator: camera channel", () => {
  it("passes camera snapshots through as camera_sample", () => {
    const { agg, events } = collect();
    agg.ingest({
      channel: "camera",
      position: [1, 2, 3],
      direction: [0, 0, 1],
      target: [4, 5, 6],
      fov: 0.8,
      hitMesh: "wall",
      hitPoint: [7, 8, 9],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "camera_sample",
      position: [1, 2, 3],
      direction: [0, 0, 1],
      target: [4, 5, 6],
      fov: 0.8,
      hitMesh: "wall",
      hitPoint: [7, 8, 9],
    });
    expectValid(events[0]!);
  });

  it("omits optional fields when absent", () => {
    const { agg, events } = collect();
    agg.ingest({ channel: "camera", position: [0, 0, 0], direction: [1, 0, 0] });
    expect(events[0]).not.toHaveProperty("target");
    expect(events[0]).not.toHaveProperty("fov");
    expect(events[0]).not.toHaveProperty("hitMesh");
  });
});

describe("aggregator: perf channel", () => {
  it("computes nearest-rank percentiles and longFrames over the window", () => {
    const { agg, events } = collect();
    // 10 frames, one slow (60ms > 50ms jank threshold).
    const frames = new Float32Array([16, 16, 17, 16, 18, 16, 60, 16, 17, 16]);
    agg.ingest({ channel: "perf", frameTimes: frames, fps: 59, jankFrameMs: 50, dpr: 2 });
    expect(events).toHaveLength(1);
    const e = events[0] as Record<string, unknown>;
    expect(e.type).toBe("frame_perf");
    expect(e.fps).toBe(59);
    expect(e.longFrames).toBe(1);
    // p99 of 10 ascending values → ceil(0.99*10)=10th → max (60).
    expect(e.frameTimeP99Ms).toBe(60);
    // p95 → ceil(0.95*10)=10th → 60 as well (nearest-rank).
    expect(e.frameTimeP95Ms).toBe(60);
    expect(e.dpr).toBe(2);
    expectValid(events[0]!);
  });

  it("omits percentiles for an empty window", () => {
    const { agg, events } = collect();
    agg.ingest({ channel: "perf", frameTimes: new Float32Array(0), fps: 60, jankFrameMs: 50 });
    const e = events[0] as Record<string, unknown>;
    expect(e).not.toHaveProperty("frameTimeP95Ms");
    expect(e).not.toHaveProperty("longFrames");
  });

  it("suppresses idle FPS samples within the threshold but always emits the first", () => {
    const events: EventInput[] = [];
    const agg = createAggregator({
      emit: (e) => events.push(e),
      perf: { suppressIdle: true, fpsThreshold: 1 },
    });
    const empty = () => new Float32Array(0);
    agg.ingest({ channel: "perf", frameTimes: empty(), fps: 60, jankFrameMs: 50 }); // first → emit
    agg.ingest({ channel: "perf", frameTimes: empty(), fps: 60.5, jankFrameMs: 50 }); // within 1 → drop
    agg.ingest({ channel: "perf", frameTimes: empty(), fps: 45, jankFrameMs: 50 }); // jump → emit
    expect(events.map((e) => (e as Record<string, number>).fps)).toEqual([60, 45]);
  });
});

describe("aggregator: node channel", () => {
  it("emits a pre-decomposed transform and idle-suppresses an unchanged repeat", () => {
    const { agg, events } = collect();
    const snap = {
      channel: "node" as const,
      nodeId: "hero",
      decomposed: {
        position: [1, 0, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
      },
      scaleEps: 1e-3,
    };
    agg.ingest(snap);
    agg.ingest(snap); // unchanged → suppressed
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "node_transform",
      nodeId: "hero",
      position: [1, 0, 0],
    });
    expect(events[0]).not.toHaveProperty("scale");
    expectValid(events[0]!);
  });

  it("decomposes a raw column-major matrix and keeps non-identity scale", () => {
    const { agg, events } = collect();
    // Translation (5,6,7) with uniform scale 2, no rotation. Column-major.
    const m = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 6, 7, 1]);
    agg.ingest({ channel: "node", nodeId: "rig", boneId: "spine", matrix: m, scaleEps: 1e-3 });
    const e = events[0] as Record<string, unknown>;
    expect(e.type).toBe("node_transform");
    expect(e.boneId).toBe("spine");
    expect(e.position).toEqual([5, 6, 7]);
    expect((e.scale as number[]).map((n) => Math.round(n))).toEqual([2, 2, 2]);
    expectValid(events[0]!);
  });

  it("keys idle state separately per childPath and bone", () => {
    const { agg, events } = collect();
    const base = { channel: "node" as const, nodeId: "a", scaleEps: 1e-3 };
    const t = {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
    };
    agg.ingest({ ...base, decomposed: t });
    agg.ingest({ ...base, childPath: "arm", decomposed: t });
    agg.ingest({ ...base, boneId: "hand", decomposed: t });
    expect(events).toHaveLength(3); // distinct keys → all emitted
  });
});

describe("aggregator: visibility channel", () => {
  it("accumulates per-tick dwell and flushes one rounded summary per object", () => {
    const { agg, events } = collect();
    // Object straight ahead of camera looking down +Z.
    for (let i = 0; i < 3; i++) {
      agg.ingest({
        channel: "visibilityTick",
        stepMs: 16.7,
        camPos: [0, 0, 0],
        forward: [0, 0, 1],
        fov: 0.8,
        meshes: [{ mesh: "chair", center: [0, 0, 5], radius: 1 }],
      });
    }
    agg.ingest({ channel: "visibilityFlush" });
    expect(events).toHaveLength(1);
    const e = events[0] as Record<string, unknown>;
    expect(e.type).toBe("mesh_visibility");
    expect(e.mesh).toBe("chair");
    expect(e.visibleMs).toBe(Math.round(16.7 * 3));
    expect(e.centeredMs).toBe(Math.round(16.7 * 3)); // dead ahead → centred
    expect(typeof e.maxScreenFraction).toBe("number");
    expectValid(events[0]!);
  });

  it("rides bounds once then dedupes unchanged bounds, and rounds to mm", () => {
    const events: EventInput[] = [];
    const agg = createAggregator({
      emit: (e) => events.push(e),
      visibility: {
        centeredCos: Math.cos((12 * Math.PI) / 180),
        boundingBox: true,
        boundsEps: 1e-3,
      },
    });
    const tick = () =>
      agg.ingest({
        channel: "visibilityTick",
        stepMs: 16,
        camPos: [0, 0, 0],
        forward: [0, 0, 1],
        fov: 0.8,
        meshes: [{ mesh: "box", center: [0, 0, 5], radius: 1, aabb: [-1.0004, -1, 4, 1, 1, 6] }],
      });
    tick();
    agg.ingest({ channel: "visibilityFlush" });
    tick();
    agg.ingest({ channel: "visibilityFlush" });
    const first = events[0] as Record<string, unknown>;
    const second = events[1] as Record<string, unknown>;
    expect(first.bounds).toEqual([-1, -1, 4, 1, 1, 6]); // rounded to mm
    expect(second).not.toHaveProperty("bounds"); // unchanged → deduped
  });

  it("emits nothing on a flush with no accumulated dwell", () => {
    const { agg, events } = collect();
    agg.ingest({ channel: "visibilityFlush" });
    expect(events).toHaveLength(0);
  });
});

describe("aggregator: gesture + hover channels", () => {
  it("classifies a gesture bracket and emits camera_gesture", () => {
    const { agg, events } = collect();
    agg.ingest({
      channel: "gesture",
      durationMs: 320,
      start: { position: [0, 0, 0], forward: [0, 0, 1] },
      end: { position: [0, 0, 0], forward: [1, 0, 0] }, // 90° forward swing → orbit
    });
    expect(events).toHaveLength(1);
    const e = events[0] as Record<string, unknown>;
    expect(e.type).toBe("camera_gesture");
    expect(e.durationMs).toBe(320);
    expect(typeof e.kind).toBe("string");
    expectValid(events[0]!);
  });

  it("drops a sub-threshold gesture (no navigation)", () => {
    const { agg, events } = collect();
    agg.ingest({
      channel: "gesture",
      durationMs: 50,
      start: { position: [0, 0, 0], forward: [0, 0, 1] },
      end: { position: [0, 0, 0], forward: [0, 0, 1] }, // no movement
    });
    expect(events).toHaveLength(0);
  });

  it("passes a hover episode through as hover_dwell", () => {
    const { agg, events } = collect();
    agg.ingest({ channel: "hover", mesh: "lamp", dwellMs: 700, source: "mouse" });
    expect(events[0]).toMatchObject({
      type: "hover_dwell",
      mesh: "lamp",
      dwellMs: 700,
      source: "mouse",
    });
    expectValid(events[0]!);
  });
});

describe("aggregator: reset", () => {
  it("clears windowed and idle state", () => {
    const { agg, events } = collect();
    const t = {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
    };
    agg.ingest({ channel: "node", nodeId: "x", decomposed: t, scaleEps: 1e-3 });
    agg.reset();
    agg.ingest({ channel: "node", nodeId: "x", decomposed: t, scaleEps: 1e-3 }); // after reset → not suppressed
    expect(events).toHaveLength(2);
  });
});

describe("aggregator: does not mutate or transfer in main mode", () => {
  it("leaves the frameTimes buffer usable (no transfer on the main path)", () => {
    const { agg } = collect();
    const frames = new Float32Array([16, 17, 18]);
    const spy = vi.spyOn(frames, "sort"); // ensure we sort a copy, not the input
    agg.ingest({ channel: "perf", frameTimes: frames, fps: 60, jankFrameMs: 50 });
    expect(spy).not.toHaveBeenCalled();
    expect(Array.from(frames)).toEqual([16, 17, 18]); // input order preserved
  });
});
