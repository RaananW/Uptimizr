import { describe, expect, it } from "vitest";
import { anyEventSchema, type AnyEvent, type NodeTransformEvent } from "@uptimizr/schema";
import {
  toEventRow,
  formatUtcTimestamp,
  toNodeSampleRow,
  nodeSampleRowToEvent,
} from "../events.js";

const base = {
  projectId: "p1",
  sessionId: "s1",
  ts: Date.UTC(2024, 5, 16, 10, 0, 0) + 123, // 2024-06-16T10:00:00.123Z
  sdkVersion: "0.1.0",
};

function event(extra: Record<string, unknown>): AnyEvent {
  return anyEventSchema.parse({ ...base, ...extra });
}

describe("formatUtcTimestamp", () => {
  it("formats epoch ms as UTC DateTime64(3)", () => {
    expect(formatUtcTimestamp(base.ts)).toBe("2024-06-16 10:00:00.123");
  });

  it("pads milliseconds to three digits", () => {
    expect(formatUtcTimestamp(Date.UTC(2024, 5, 16, 10, 0, 0) + 5)).toMatch(/\.005$/);
  });
});

describe("toEventRow", () => {
  it("promotes camera position and direction into array columns", () => {
    const row = toEventRow(
      event({
        type: "camera_sample",
        position: [1, 2, 3],
        direction: [0, 0, 1],
      }),
    );
    expect(row.event_type).toBe("camera_sample");
    expect(row.position).toEqual([1, 2, 3]);
    expect(row.direction).toEqual([0, 0, 1]);
    expect(row.ts).toBe("2024-06-16 10:00:00.123");
  });

  it("promotes camera_sample projection intrinsics into their columns (#22)", () => {
    const row = toEventRow(
      event({
        type: "camera_sample",
        position: [1, 2, 3],
        direction: [0, 0, 1],
        fov: 1.2,
        aspect: 1.6,
        near: 0.1,
      }),
    );
    expect(row.fov).toBeCloseTo(1.2);
    expect(row.aspect).toBeCloseTo(1.6);
    expect(row.near).toBeCloseTo(0.1);
  });

  it("defaults missing camera intrinsics to 0 (#22)", () => {
    const row = toEventRow(
      event({ type: "camera_sample", position: [1, 2, 3], direction: [0, 0, 1] }),
    );
    expect(row.fov).toBe(0);
    expect(row.aspect).toBe(0);
    expect(row.near).toBe(0);
  });

  it("maps pointer screen and hit mesh", () => {
    const row = toEventRow(
      event({
        type: "pointer_click",
        screen: [0.5, 0.25],
        hitMesh: "Cube",
        hitPoint: [4, 5, 6],
        button: 0,
      }),
    );
    expect(row.screen).toEqual([0.5, 0.25]);
    expect(row.mesh).toBe("Cube");
    expect(row.hit_point).toEqual([4, 5, 6]);
  });

  it("maps mesh_interaction mesh and point", () => {
    const row = toEventRow(
      event({ type: "mesh_interaction", mesh: "Door", kind: "click", point: [7, 8, 9] }),
    );
    expect(row.mesh).toBe("Door");
    expect(row.hit_point).toEqual([7, 8, 9]);
  });

  it("captures fps for frame_perf and leaves vectors empty", () => {
    const row = toEventRow(event({ type: "frame_perf", fps: 59.5 }));
    expect(row.fps).toBeCloseTo(59.5);
    expect(row.position).toEqual([]);
    expect(row.screen).toEqual([]);
  });

  it("promotes frame_perf percentile/jank/resolution detail into their columns (#80)", () => {
    const row = toEventRow(
      event({
        type: "frame_perf",
        fps: 58,
        frameTimeMs: 17.2,
        frameTimeP95Ms: 28.4,
        longFrames: 3,
        dpr: 2,
        renderScale: 0.75,
      }),
    );
    expect(row.frame_time_ms).toBeCloseTo(17.2);
    expect(row.frame_time_p95_ms).toBeCloseTo(28.4);
    expect(row.long_frames).toBe(3);
    expect(row.dpr).toBe(2);
    expect(row.render_scale).toBeCloseTo(0.75);
  });

  it("defaults unreported frame_perf detail to 0 (#80)", () => {
    // A minimal frame_perf sample (fps only) leaves the optional detail columns
    // at 0 so the perf aggregates' NULLIF can exclude them where 0 is not a
    // meaningful sample (e.g. dpr / render_scale).
    const row = toEventRow(event({ type: "frame_perf", fps: 60 }));
    expect(row.frame_time_ms).toBe(0);
    expect(row.frame_time_p95_ms).toBe(0);
    expect(row.long_frames).toBe(0);
    expect(row.dpr).toBe(0);
    expect(row.render_scale).toBe(0);
  });

  it("preserves the full event in the JSON payload", () => {
    const ev = event({ type: "custom", name: "add_to_cart", props: { sku: "abc" } });
    const row = toEventRow(ev);
    expect(row.name).toBe("add_to_cart");
    expect(JSON.parse(row.payload)).toMatchObject({ type: "custom", name: "add_to_cart" });
  });

  it("defaults optional envelope fields", () => {
    const row = toEventRow(event({ type: "session_start" }));
    expect(row.visitor_id).toBe("");
    expect(row.url).toBe("");
  });

  it("defaults scene_id to 'default' when no scene is set", () => {
    const row = toEventRow(event({ type: "session_start" }));
    expect(row.scene_id).toBe("default");
  });

  it("promotes the envelope sceneId into the scene_id column", () => {
    const row = toEventRow(
      event({
        type: "camera_sample",
        position: [0, 0, 0],
        direction: [0, 0, 1],
        sceneId: "level-3",
      }),
    );
    expect(row.scene_id).toBe("level-3");
  });

  it("defaults source to 'mouse' and leaves input-source columns empty (ADR 0011)", () => {
    const row = toEventRow(event({ type: "pointer_move", screen: [0.5, 0.5] }));
    expect(row.source).toBe("mouse");
    expect(row.handedness).toBe("");
    expect(row.source_id).toBe("");
    expect(row.ray_origin).toEqual([]);
    expect(row.ray_direction).toEqual([]);
  });

  it("promotes input source, handedness, sourceId and ray into their columns (ADR 0011)", () => {
    const row = toEventRow(
      event({
        type: "mesh_interaction",
        mesh: "lever-1",
        kind: "grab",
        point: [1, 2, 3],
        source: "xr-controller",
        handedness: "right",
        sourceId: "input-0",
        ray: { origin: [0, 1.6, 0], direction: [0, 0, -1] },
      }),
    );
    expect(row.source).toBe("xr-controller");
    expect(row.handedness).toBe("right");
    expect(row.source_id).toBe("input-0");
    expect(row.ray_origin).toEqual([0, 1.6, 0]);
    expect(row.ray_direction).toEqual([0, 0, -1]);
  });

  it("promotes resource_sample footprint metrics into their columns (#44)", () => {
    const row = toEventRow(
      event({
        type: "resource_sample",
        textureBytes: 1_000_000,
        geometryBytes: 500_000,
        triangles: 120_000,
        vertices: 90_000,
        jsHeapBytes: 40_000_000,
      }),
    );
    expect(row.texture_bytes).toBe(1_000_000);
    expect(row.geometry_bytes).toBe(500_000);
    expect(row.triangles).toBe(120_000);
    expect(row.vertices).toBe(90_000);
    expect(row.js_heap_bytes).toBe(40_000_000);
  });

  it("defaults unreported resource_sample metrics to 0 (#44)", () => {
    // A partial sample (heap + triangles only) leaves the other footprint
    // columns at 0 so the aggregate's NULLIF can exclude them from averages.
    const row = toEventRow(
      event({ type: "resource_sample", triangles: 240_000, jsHeapBytes: 80_000_000 }),
    );
    expect(row.triangles).toBe(240_000);
    expect(row.js_heap_bytes).toBe(80_000_000);
    expect(row.texture_bytes).toBe(0);
    expect(row.geometry_bytes).toBe(0);
    expect(row.vertices).toBe(0);
  });

  it("promotes capability_change kind into name and tokens into their columns (#49)", () => {
    const row = toEventRow(
      event({
        type: "capability_change",
        kind: "graphics-backend",
        from: "webgpu",
        to: "webgl2",
        reason: "device-init-failed",
      }),
    );
    // `kind` reuses the shared `name` column; from/to get their own columns;
    // `reason` is free-form and stays in the JSON payload only.
    expect(row.name).toBe("graphics-backend");
    expect(row.cap_from).toBe("webgpu");
    expect(row.cap_to).toBe("webgl2");
    expect(JSON.parse(row.payload).reason).toBe("device-init-failed");
  });

  it("defaults unreported capability_change tokens to '' (#49)", () => {
    const row = toEventRow(event({ type: "capability_change", kind: "device-recovery" }));
    expect(row.name).toBe("device-recovery");
    expect(row.cap_from).toBe("");
    expect(row.cap_to).toBe("");
  });
});

function nodeEvent(extra: Record<string, unknown>): NodeTransformEvent {
  return anyEventSchema.parse({
    ...base,
    type: "node_transform",
    ...extra,
  }) as NodeTransformEvent;
}

describe("toNodeSampleRow (node_transform → node_samples, ADR 0027)", () => {
  it("maps a Tier-1 node sample (no bone, no scale)", () => {
    const row = toNodeSampleRow(
      nodeEvent({ nodeId: "npc-guard", position: [1, 0, 3], rotation: [0, 0, 0, 1] }),
    );
    expect(row.node_id).toBe("npc-guard");
    expect(row.bone_id).toBe("");
    expect(row.position).toEqual([1, 0, 3]);
    expect(row.rotation).toEqual([0, 0, 0, 1]);
    expect(row.scale).toEqual([]);
    expect(row.scene_id).toBe("default");
    expect(row.ts).toBe("2024-06-16 10:00:00.123");
  });

  it("maps a Tier-2 bone sample (boneId + scale + sceneId)", () => {
    const row = toNodeSampleRow(
      nodeEvent({
        nodeId: "npc-guard",
        boneId: "mixamorig:RightHand",
        position: [0, 0.2, 0],
        rotation: [0, 0.7071, 0, 0.7071],
        scale: [1, 1, 1],
        sceneId: "lobby",
      }),
    );
    expect(row.bone_id).toBe("mixamorig:RightHand");
    expect(row.scale).toEqual([1, 1, 1]);
    expect(row.scene_id).toBe("lobby");
  });
});

describe("nodeSampleRowToEvent (node_samples → node_transform, ADR 0027)", () => {
  it("round-trips a Tier-1 sample back into a replay-complete event", () => {
    const original = nodeEvent({ nodeId: "elevator", position: [0, 2, 0], rotation: [0, 0, 0, 1] });
    const row = toNodeSampleRow(original);
    const restored = nodeSampleRowToEvent(row, base.ts);
    expect(anyEventSchema.safeParse(restored).success).toBe(true);
    expect(restored).toMatchObject({
      type: "node_transform",
      nodeId: "elevator",
      position: [0, 2, 0],
      rotation: [0, 0, 0, 1],
    });
    expect(restored.boneId).toBeUndefined();
    expect(restored.scale).toBeUndefined();
    expect(restored.sceneId).toBeUndefined();
  });

  it("round-trips a Tier-2 sample (bone, scale, scene) and stays schema-valid", () => {
    const original = nodeEvent({
      nodeId: "npc-guard",
      boneId: "mixamorig:Head",
      position: [0, 1.7, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      sceneId: "lobby",
    });
    const restored = nodeSampleRowToEvent(toNodeSampleRow(original), base.ts);
    expect(anyEventSchema.safeParse(restored).success).toBe(true);
    expect(restored).toMatchObject({
      boneId: "mixamorig:Head",
      scale: [1, 1, 1],
      sceneId: "lobby",
      ts: base.ts,
    });
  });
});
