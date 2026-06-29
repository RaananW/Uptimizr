import { describe, expect, it } from "vitest";
import type { CollectorContext, EventInput } from "@uptimizr/sdk-core";
import type { EngineBridge } from "@uptimizr/web-export";
import { GODOT_FRAME, godotCollector } from "../index.js";

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

describe("@uptimizr/godot", () => {
  it("declares Godot's native frame (right-handed, y-up, meters)", () => {
    expect(GODOT_FRAME).toEqual({ handedness: "right", upAxis: "y", unitScale: 1 });
  });

  it("names the collector 'godot'", () => {
    expect(godotCollector().name).toBe("godot");
  });

  it("normalizes a pushed pose by negating Z (RH → canonical LH)", () => {
    const { ctx, events } = makeCtx();
    let bridge: EngineBridge | undefined;
    const handle = godotCollector({ onBridge: (b) => (bridge = b) }).start(ctx)!;
    bridge!.pushPose([1, 2, 3], [0, 0, 1], [0, 1, 0]);
    expect(events).toEqual([
      { type: "camera_sample", position: [1, 2, -3], direction: [0, 0, -1] },
    ]);
    handle.stop();
  });

  it("attaches the bridge to a window global and removes it on stop", () => {
    const { ctx } = makeCtx();
    const handle = godotCollector().start(ctx)!;
    expect((globalThis as Record<string, unknown>).__uptimizr_godot__).toBeDefined();
    handle.stop();
    expect((globalThis as Record<string, unknown>).__uptimizr_godot__).toBeUndefined();
  });
});
