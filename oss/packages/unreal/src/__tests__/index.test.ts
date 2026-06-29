import { describe, expect, it } from "vitest";
import type { CollectorContext, EventInput } from "@uptimizr/sdk-core";
import type { EngineBridge } from "@uptimizr/web-export";
import { UNREAL_FRAME, unrealCollector } from "../index.js";

function makeCtx() {
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
    now: () => 1000,
  } as unknown as CollectorContext;
  return { ctx, events };
}

describe("@uptimizr/unreal", () => {
  it("declares Unreal's native frame (left-handed, z-up, centimeters)", () => {
    expect(UNREAL_FRAME).toEqual({ handedness: "left", upAxis: "z", unitScale: 100 });
  });

  it("names the collector 'unreal'", () => {
    expect(unrealCollector().name).toBe("unreal");
  });

  it("rebases z-up→y-up and scales cm→m on a pushed pose and pick", () => {
    const { ctx, events } = makeCtx();
    let bridge: EngineBridge | undefined;
    const handle = unrealCollector({ onBridge: (b) => (bridge = b) }).start(ctx)!;
    // position cm [100,200,300] → /100 → [1,2,3] → rebase (x,z,-y) → [1,3,-2]
    bridge!.pushPose([100, 200, 300], [0, 0, 1], [0, 1, 0]);
    bridge!.pushPick("Door", [0, 0, 100]);
    expect(events).toEqual([
      { type: "camera_sample", position: [1, 3, -2], direction: [0, 1, 0] },
      { type: "mesh_interaction", mesh: "Door", kind: "pick", point: [0, 1, 0] },
    ]);
    handle.stop();
  });

  it("attaches the bridge to a window global and removes it on stop", () => {
    const { ctx } = makeCtx();
    const handle = unrealCollector().start(ctx)!;
    expect((globalThis as Record<string, unknown>).__uptimizr_unreal__).toBeDefined();
    handle.stop();
    expect((globalThis as Record<string, unknown>).__uptimizr_unreal__).toBeUndefined();
  });
});
