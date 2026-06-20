import { describe, it, expect } from "vitest";
import {
  anyEventSchema,
  eventSchemaByType,
  collectRequestSchema,
  EVENT_TYPES,
  SCHEMA_VERSION,
  LIMITS,
  type CameraSampleEvent,
} from "../index.js";

const baseEnvelope = {
  projectId: "proj_demo",
  sessionId: "sess_123",
  ts: 1_750_000_000_000,
  sdkVersion: "0.1.0",
};

describe("event registry", () => {
  it("exposes a schema for every declared event type", () => {
    for (const type of EVENT_TYPES) {
      expect(eventSchemaByType[type]).toBeDefined();
    }
  });

  it("registry keys exactly match EVENT_TYPES", () => {
    expect(Object.keys(eventSchemaByType).sort()).toEqual([...EVENT_TYPES].sort());
  });
});

describe("anyEventSchema (discriminated union)", () => {
  it("validates a well-formed camera_sample event", () => {
    const event = {
      ...baseEnvelope,
      type: "camera_sample",
      position: [0, 1, 2],
      direction: [0, 0, 1],
    };
    const parsed = anyEventSchema.parse(event);
    expect(parsed.type).toBe("camera_sample");
    expect((parsed as CameraSampleEvent).position).toEqual([0, 1, 2]);
  });

  it("rejects an event with an unknown type", () => {
    const event = { ...baseEnvelope, type: "not_a_real_event" };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects an event missing required envelope fields", () => {
    const event = { type: "session_start" };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects a vector of the wrong arity", () => {
    const event = {
      ...baseEnvelope,
      type: "camera_sample",
      position: [0, 1],
      direction: [0, 0, 1],
    };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });

  it("validates a Tier-1 node_transform (no bone)", () => {
    const event = {
      ...baseEnvelope,
      type: "node_transform",
      nodeId: "npc-guard",
      position: [1, 0, 3],
      rotation: [0, 0, 0, 1],
    };
    const parsed = anyEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("node_transform");
      expect("boneId" in parsed.data && parsed.data.boneId).toBeFalsy();
    }
  });

  it("validates a Tier-2 node_transform with a bone and scale", () => {
    const event = {
      ...baseEnvelope,
      type: "node_transform",
      nodeId: "npc-guard",
      boneId: "mixamorig:RightHand",
      position: [0, 0.2, 0],
      rotation: [0, 0.7071, 0, 0.7071],
      scale: [1, 1, 1],
    };
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects a node_transform missing nodeId", () => {
    const event = {
      ...baseEnvelope,
      type: "node_transform",
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects a node_transform whose rotation is not a quaternion (4-tuple)", () => {
    const event = {
      ...baseEnvelope,
      type: "node_transform",
      nodeId: "elevator",
      position: [0, 0, 0],
      rotation: [0, 0, 1],
    };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });

  it("accepts a custom event with arbitrary props", () => {
    const event = {
      ...baseEnvelope,
      type: "custom",
      name: "add_to_cart",
      props: { sku: "ABC", qty: 2, gift: true },
    };
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("validates pointer_down and pointer_up with a button", () => {
    for (const type of ["pointer_down", "pointer_up"] as const) {
      const event = {
        ...baseEnvelope,
        type,
        screen: [0.5, 0.5],
        hitMesh: "box-1",
        button: 0,
      };
      const parsed = anyEventSchema.safeParse(event);
      expect(parsed.success).toBe(true);
    }
  });

  it("accepts session_start with scene and anonymized user metadata", () => {
    const event = {
      ...baseEnvelope,
      type: "session_start",
      device: { engine: "webgl2" },
      scene: {
        description: "product-configurator",
        cameraType: "arc-rotate",
        cameraName: "mainCamera",
        meshCount: 12,
      },
      user: { id: "anon_abc123", traits: { plan: "pro", seats: 5 } },
    };
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects session_start with an invalid camera type", () => {
    const event = {
      ...baseEnvelope,
      type: "session_start",
      scene: { cameraType: "spinny" },
    };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });

  it("accepts session_start with connector provenance and a coordinate frame (ADR 0018)", () => {
    const event = {
      ...baseEnvelope,
      type: "session_start",
      connector: {
        name: "babylon",
        version: "7.0.0",
        coordinateSystem: { handedness: "left", upAxis: "y", unitScale: 1 },
      },
    };
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects session_start with an invalid coordinate handedness", () => {
    const event = {
      ...baseEnvelope,
      type: "session_start",
      connector: { name: "three", coordinateSystem: { handedness: "sideways" } },
    };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });

  it("accepts session_start with a graphics backend block (ADR 0021)", () => {
    const event = {
      ...baseEnvelope,
      type: "session_start",
      graphics: {
        api: "webgpu",
        backend: "metal",
        apiVersion: "1.0",
        shadingLanguage: "wgsl",
      },
    };
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects session_start with an unknown graphics api", () => {
    const event = {
      ...baseEnvelope,
      type: "session_start",
      graphics: { api: "metalgl" },
    };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });

  it("accepts a keyboard input_action with a code and source (ADR 0023)", () => {
    const event = {
      ...baseEnvelope,
      type: "input_action",
      action: "next-camera",
      code: "KeyN",
      pressed: true,
      source: "keyboard",
    };
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a gamepad input_action with a button and handedness", () => {
    const event = {
      ...baseEnvelope,
      type: "input_action",
      action: "jump",
      button: 0,
      source: "gamepad",
      handedness: "right",
    };
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects input_action without an action label", () => {
    const event = {
      ...baseEnvelope,
      type: "input_action",
      code: "KeyW",
      source: "keyboard",
    };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });
});

describe("camera_gesture (ADR 0025)", () => {
  it("accepts an orbit gesture with multi-component magnitudes and source", () => {
    const event = {
      ...baseEnvelope,
      type: "camera_gesture",
      kind: "orbit",
      durationMs: 420,
      orbitDeg: 35.5,
      zoomRatio: 1.05,
      source: "mouse",
    };
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts an untyped navigate fallback with only a duration", () => {
    const event = {
      ...baseEnvelope,
      type: "camera_gesture",
      kind: "navigate",
      durationMs: 120,
    };
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts an XR fly gesture distinguished by source", () => {
    const event = {
      ...baseEnvelope,
      type: "camera_gesture",
      kind: "fly",
      durationMs: 900,
      panDist: 2.4,
      source: "xr-controller",
      handedness: "left",
    };
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects an unknown gesture kind", () => {
    const event = {
      ...baseEnvelope,
      type: "camera_gesture",
      kind: "spin",
      durationMs: 100,
    };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects a non-positive zoomRatio", () => {
    const event = {
      ...baseEnvelope,
      type: "camera_gesture",
      kind: "zoom",
      durationMs: 100,
      zoomRatio: 0,
    };
    expect(anyEventSchema.safeParse(event).success).toBe(false);
  });
});

describe("performance depth (design §C)", () => {
  it("accepts a frame_perf carrying jank percentiles and render resolution", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "frame_perf",
      fps: 60,
      frameTimeMs: 16.6,
      frameTimeP95Ms: 22,
      frameTimeP99Ms: 48,
      longFrames: 3,
      dpr: 2,
      renderScale: 0.75,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a frame_perf with a non-positive renderScale", () => {
    expect(
      anyEventSchema.safeParse({ ...baseEnvelope, type: "frame_perf", fps: 60, renderScale: 0 })
        .success,
    ).toBe(false);
  });

  it("accepts an asset_load with a distinct time-to-interactive", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "asset_load",
      name: "scene.glb",
      loadMs: 1200,
      ttffMs: 400,
      ttiMs: 1500,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("mesh_visibility (object attention / dwell, design §A)", () => {
  it("accepts a bucketed visibility summary with all optional prominence fields", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "mesh_visibility",
      mesh: "product-hero",
      visibleMs: 4200,
      centeredMs: 1800,
      maxScreenFraction: 0.42,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the minimal form (mesh + visibleMs only)", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "mesh_visibility",
        mesh: "floor",
        visibleMs: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects a screen fraction outside the 0..1 range", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "mesh_visibility",
        mesh: "wall",
        visibleMs: 10,
        maxScreenFraction: 1.5,
      }).success,
    ).toBe(false);
  });

  it("accepts an optional world-space bounding box (#53 ride-along)", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "mesh_visibility",
      mesh: "product-hero",
      visibleMs: 4200,
      bounds: [-1, 0, -1, 1, 2, 1],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a bounding box that is not a 6-tuple", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "mesh_visibility",
        mesh: "product-hero",
        visibleMs: 10,
        bounds: [0, 0, 0, 1, 1],
      }).success,
    ).toBe(false);
  });

  it("rejects a visibility summary without a mesh name", () => {
    expect(
      anyEventSchema.safeParse({ ...baseEnvelope, type: "mesh_visibility", visibleMs: 10 }).success,
    ).toBe(false);
  });
});

describe("hover_dwell (hesitation / interactivity discoverability, design §D)", () => {
  it("accepts a bucketed hover summary with an input source (#48, ADR 0011)", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "hover_dwell",
      mesh: "config-knob",
      dwellMs: 2400,
      source: "mouse",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the minimal form (mesh + dwellMs only)", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "hover_dwell",
        mesh: "config-knob",
        dwellMs: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects a negative dwell time", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "hover_dwell",
        mesh: "config-knob",
        dwellMs: -5,
      }).success,
    ).toBe(false);
  });

  it("rejects a hover summary without a mesh name", () => {
    expect(
      anyEventSchema.safeParse({ ...baseEnvelope, type: "hover_dwell", dwellMs: 10 }).success,
    ).toBe(false);
  });
});

describe("compile_stall (shader / pipeline compile hitch, design §C)", () => {
  it("accepts a stall with a duration and a phase (#42)", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "compile_stall",
      durationMs: 18.5,
      phase: "shader",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the minimal form (durationMs only, phase omitted)", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "compile_stall",
        durationMs: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects a negative duration", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "compile_stall",
        durationMs: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown phase", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "compile_stall",
        durationMs: 5,
        phase: "linking",
      }).success,
    ).toBe(false);
  });

  it("rejects a stall without a duration", () => {
    expect(
      anyEventSchema.safeParse({ ...baseEnvelope, type: "compile_stall", phase: "shader" }).success,
    ).toBe(false);
  });
});

describe("resource_sample (GPU / memory footprint, design §C)", () => {
  it("accepts a full footprint sample (#44)", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "resource_sample",
      textureBytes: 12_000_000,
      geometryBytes: 4_500_000,
      triangles: 250_000,
      vertices: 180_000,
      jsHeapBytes: 88_000_000,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a partial sample (engines expose different subsets)", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "resource_sample",
        triangles: 1000,
        jsHeapBytes: 1_000_000,
      }).success,
    ).toBe(true);
  });

  it("accepts the empty form (all fields optional)", () => {
    expect(anyEventSchema.safeParse({ ...baseEnvelope, type: "resource_sample" }).success).toBe(
      true,
    );
  });

  it("rejects a negative byte count", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "resource_sample",
        jsHeapBytes: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects a fractional triangle count", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "resource_sample",
        triangles: 10.5,
      }).success,
    ).toBe(false);
  });
});

describe("capability_change (fallbacks & recovery, design §E)", () => {
  it("accepts a WebGPU→WebGL2 backend downgrade (#49)", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "capability_change",
      kind: "graphics-backend",
      from: "webgpu",
      to: "webgl2",
      reason: "device-init-failed",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a device-recovery with only a kind (from/to optional)", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "capability_change",
        kind: "device-recovery",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "capability_change",
        kind: "teleport",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing kind", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "capability_change",
        from: "webgpu",
      }).success,
    ).toBe(false);
  });

  it("rejects an over-long token (cardinality/PII guard)", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "capability_change",
        kind: "quality",
        to: "x".repeat(65),
      }).success,
    ).toBe(false);
  });
});

describe("collectRequestSchema", () => {
  it("defaults schemaVersion when omitted", () => {
    const parsed = collectRequestSchema.parse({
      events: [{ ...baseEnvelope, type: "session_start" }],
    });
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("rejects an empty batch", () => {
    expect(collectRequestSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it("rejects a batch exceeding the per-batch event cap", () => {
    const event = { ...baseEnvelope, type: "session_start" as const };
    const events = Array.from({ length: LIMITS.maxBatchEvents + 1 }, () => event);
    expect(collectRequestSchema.safeParse({ events }).success).toBe(false);
  });

  it("accepts a batch at exactly the per-batch event cap", () => {
    const event = { ...baseEnvelope, type: "session_start" as const };
    const events = Array.from({ length: LIMITS.maxBatchEvents }, () => event);
    expect(collectRequestSchema.safeParse({ events }).success).toBe(true);
  });
});

describe("ingestion payload bounds (#3)", () => {
  it("rejects an envelope projectId over the cap", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        projectId: "p".repeat(LIMITS.maxProjectIdLength + 1),
        type: "session_start",
      }).success,
    ).toBe(false);
  });

  it("rejects an envelope sessionId over the cap", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        sessionId: "s".repeat(LIMITS.maxSessionIdLength + 1),
        type: "session_start",
      }).success,
    ).toBe(false);
  });

  it("rejects an over-length page url", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "session_start",
        url: "https://x/".concat("a".repeat(LIMITS.maxUrlLength)),
      }).success,
    ).toBe(false);
  });

  it("rejects an over-length mesh name on mesh_interaction", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "mesh_interaction",
        mesh: "m".repeat(LIMITS.maxMeshNameLength + 1),
        kind: "click",
      }).success,
    ).toBe(false);
  });

  it("rejects an over-length custom event name", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "custom",
        name: "n".repeat(LIMITS.maxCustomNameLength + 1),
      }).success,
    ).toBe(false);
  });

  it("rejects an over-length custom prop string value", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "custom",
        name: "add_to_cart",
        props: { note: "x".repeat(LIMITS.maxCustomPropValueLength + 1) },
      }).success,
    ).toBe(false);
  });

  it("rejects a custom props record with too many entries", () => {
    const props: Record<string, number> = {};
    for (let i = 0; i <= LIMITS.maxCustomPropEntries; i++) props[`k${i}`] = i;
    expect(
      anyEventSchema.safeParse({ ...baseEnvelope, type: "custom", name: "evt", props }).success,
    ).toBe(false);
  });

  it("rejects a user traits record with too many entries", () => {
    const traits: Record<string, number> = {};
    for (let i = 0; i <= LIMITS.maxUserTraitEntries; i++) traits[`k${i}`] = i;
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "session_start",
        user: { id: "anon", traits },
      }).success,
    ).toBe(false);
  });
});

describe("scene dimension (ADR 0010)", () => {
  it("validates a scene_change marker carrying the new scene via the envelope", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "scene_change",
      sceneId: "level-3",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a scene_change marker without a sceneId (back to the default scene)", () => {
    expect(anyEventSchema.safeParse({ ...baseEnvelope, type: "scene_change" }).success).toBe(true);
  });

  it("rejects a scene_change whose sceneId breaks the low-cardinality charset", () => {
    expect(
      anyEventSchema.safeParse({ ...baseEnvelope, type: "scene_change", sceneId: "has space" })
        .success,
    ).toBe(false);
    expect(
      anyEventSchema.safeParse({ ...baseEnvelope, type: "scene_change", sceneId: "x".repeat(65) })
        .success,
    ).toBe(false);
  });

  it("accepts an optional sceneId on the envelope of any event", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "camera_sample",
      position: [0, 0, 0],
      direction: [0, 0, 1],
      sceneId: "lobby",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an envelope sceneId that breaks the low-cardinality charset", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "frame_perf",
      fps: 60,
      sceneId: "bad/scene id",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("input-source-agnostic interactions (ADR 0011)", () => {
  it("accepts a mesh_interaction carrying source, handedness, sourceId and a ray", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "mesh_interaction",
      mesh: "lever-1",
      kind: "grab",
      point: [1, 2, 3],
      source: "xr-controller",
      handedness: "right",
      sourceId: "input-0",
      ray: { origin: [0, 1.6, 0], direction: [0, 0, -1] },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the new XR mesh-interaction kinds", () => {
    for (const kind of ["select", "squeeze", "grab", "release", "teleport"] as const) {
      const parsed = anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "mesh_interaction",
        mesh: "node-1",
        kind,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("accepts a pointer event with no 2D screen position but a world-space ray", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "pointer_move",
      source: "hand",
      ray: { origin: [0, 1, 0], direction: [0, 0, -1] },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an interaction whose source is outside the vocabulary", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "pointer_click",
      screen: [0.5, 0.5],
      source: "telepathy",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("browser & runtime lifecycle events", () => {
  it("validates a viewport_resize with width, height and dpr", () => {
    const parsed = anyEventSchema.safeParse({
      ...baseEnvelope,
      type: "viewport_resize",
      width: 1280,
      height: 720,
      dpr: 2,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a viewport_resize without an optional dpr", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "viewport_resize",
        width: 800,
        height: 600,
      }).success,
    ).toBe(true);
  });

  it("rejects a viewport_resize with a non-positive dimension", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "viewport_resize",
        width: 0,
        height: 600,
      }).success,
    ).toBe(false);
  });

  it("validates visibility_change for both states", () => {
    for (const state of ["visible", "hidden"] as const) {
      expect(
        anyEventSchema.safeParse({ ...baseEnvelope, type: "visibility_change", state }).success,
      ).toBe(true);
    }
  });

  it("rejects visibility_change with an unknown state", () => {
    expect(
      anyEventSchema.safeParse({ ...baseEnvelope, type: "visibility_change", state: "minimized" })
        .success,
    ).toBe(false);
  });

  it("validates focus_change carrying a boolean focused flag", () => {
    expect(
      anyEventSchema.safeParse({ ...baseEnvelope, type: "focus_change", focused: false }).success,
    ).toBe(true);
  });

  it("rejects focus_change missing the focused flag", () => {
    expect(anyEventSchema.safeParse({ ...baseEnvelope, type: "focus_change" }).success).toBe(false);
  });

  it("validates context_lost with and without an optional reason", () => {
    expect(anyEventSchema.safeParse({ ...baseEnvelope, type: "context_lost" }).success).toBe(true);
    expect(
      anyEventSchema.safeParse({ ...baseEnvelope, type: "context_lost", reason: "gpu reset" })
        .success,
    ).toBe(true);
  });

  it("rejects context_lost with an over-long reason", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "context_lost",
        reason: "x".repeat(513),
      }).success,
    ).toBe(false);
  });

  it("validates context_restored", () => {
    expect(anyEventSchema.safeParse({ ...baseEnvelope, type: "context_restored" }).success).toBe(
      true,
    );
  });

  it("validates runtime_error for both kinds with optional fields", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "runtime_error",
        kind: "error",
        message: "boom",
        source: "https://app.example/main.js",
        lineno: 42,
        colno: 7,
        stack: "Error: boom\n  at f (main.js:42:7)",
      }).success,
    ).toBe(true);
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "runtime_error",
        kind: "unhandledrejection",
        message: "rejected",
      }).success,
    ).toBe(true);
  });

  it("rejects runtime_error with an unknown kind", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "runtime_error",
        kind: "warning",
        message: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects runtime_error with an over-long message", () => {
    expect(
      anyEventSchema.safeParse({
        ...baseEnvelope,
        type: "runtime_error",
        kind: "error",
        message: "x".repeat(1025),
      }).success,
    ).toBe(false);
  });
});
