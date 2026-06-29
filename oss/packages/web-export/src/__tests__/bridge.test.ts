import { describe, expect, it, vi } from "vitest";
import type { CollectorContext, EventInput } from "@uptimizr/sdk-core";
import { BRIDGE_PROTOCOL_VERSION, createEngineBridge } from "../bridge.js";
import type { NativeFrame } from "../types.js";

function makeCtx(now = 1000) {
  const events: EventInput[] = [];
  const ctx = {
    config: {} as never,
    sessionId: "s1",
    emit: (e: EventInput) => events.push(e),
    track: () => {},
    trackInput: () => {},
    reportCapabilityChange: () => {},
    setScene: () => {},
    createAggregation: () => () => {},
    now: () => now,
  } as unknown as CollectorContext;
  return { ctx, events };
}

const GODOT: NativeFrame = { handedness: "right", upAxis: "y", unitScale: 1 };
const UNREAL: NativeFrame = { handedness: "left", upAxis: "z", unitScale: 100 };

describe("createEngineBridge", () => {
  it("exposes the protocol version", () => {
    const { ctx } = makeCtx();
    expect(createEngineBridge({ ctx, frame: GODOT }).protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
  });

  it("pushPose emits a canonical camera_sample (Godot Z-negated)", () => {
    const { ctx, events } = makeCtx();
    const bridge = createEngineBridge({ ctx, frame: GODOT });
    bridge.pushPose([1, 2, 3], [0, 0, 1], [0, 1, 0], 1.2);
    expect(events).toEqual([
      { type: "camera_sample", position: [1, 2, -3], direction: [0, 0, -1], fov: 1.2 },
    ]);
  });

  it("pushPose omits fov when not provided", () => {
    const { ctx, events } = makeCtx();
    createEngineBridge({ ctx, frame: GODOT }).pushPose([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    expect(events[0]).not.toHaveProperty("fov");
  });

  it("pushPick emits a normalized mesh_interaction (Unreal z-up + cm)", () => {
    const { ctx, events } = makeCtx();
    const bridge = createEngineBridge({ ctx, frame: UNREAL });
    bridge.pushPick("Door", [100, 200, 300]);
    expect(events).toEqual([
      { type: "mesh_interaction", mesh: "Door", kind: "pick", point: [1, 3, -2] },
    ]);
  });

  it("pushPick ignores an empty object name", () => {
    const { ctx, events } = makeCtx();
    createEngineBridge({ ctx, frame: GODOT }).pushPick("", [1, 1, 1]);
    expect(events).toHaveLength(0);
  });

  it("pushPerf emits frame_perf with optional longFrames", () => {
    const { ctx, events } = makeCtx();
    const bridge = createEngineBridge({ ctx, frame: GODOT });
    bridge.pushPerf(58.5, 3);
    bridge.pushPerf(60);
    expect(events).toEqual([
      { type: "frame_perf", fps: 58.5, longFrames: 3 },
      { type: "frame_perf", fps: 60 },
    ]);
  });

  it("setSceneProxy builds a canonical proxy and calls onSceneProxy", () => {
    const { ctx } = makeCtx();
    const onSceneProxy = vi.fn();
    const bridge = createEngineBridge({ ctx, frame: GODOT, sceneId: "lobby", onSceneProxy });
    bridge.setSceneProxy([{ name: "Floor", aabb: [-1, 0, -1, 1, 0, 1] }]);
    expect(onSceneProxy).toHaveBeenCalledOnce();
    const proxy = onSceneProxy.mock.calls[0]![0];
    expect(proxy.sceneId).toBe("lobby");
    expect(proxy.upAxis).toBe("y");
    expect(proxy.handedness).toBe("left");
    expect(proxy.unitScale).toBe(1);
    expect(proxy.meshes[0].name).toBe("Floor");
  });

  it("stops emitting after dispose", () => {
    const { ctx, events } = makeCtx();
    const bridge = createEngineBridge({ ctx, frame: GODOT });
    bridge.dispose();
    bridge.pushPose([0, 0, 0], [0, 0, 1], [0, 1, 0]);
    bridge.pushPerf(60);
    expect(events).toHaveLength(0);
  });
});
