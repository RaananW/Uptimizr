import { describe, expect, it } from "vitest";
import type { CollectorContext, EventInput } from "@uptimizr/sdk-core";
import type { EngineBridge } from "@uptimizr/web-export";
import { UNITY_FRAME, unityCollector } from "../index.js";

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

describe("@uptimizr/unity", () => {
  it("declares Unity's native frame (left-handed, y-up, meters)", () => {
    expect(UNITY_FRAME).toEqual({ handedness: "left", upAxis: "y", unitScale: 1 });
  });

  it("names the collector 'unity'", () => {
    expect(unityCollector().name).toBe("unity");
  });

  it("exposes the engine bridge on start and emits a canonical (identity) camera_sample", () => {
    const { ctx, events } = makeCtx();
    let bridge: EngineBridge | undefined;
    const handle = unityCollector({ onBridge: (b) => (bridge = b) }).start(ctx)!;
    expect(bridge).toBeDefined();
    bridge!.pushPose([1, 2, 3], [0, 0, 1], [0, 1, 0], 1.1);
    // Unity is already canonical — no axis conversion.
    expect(events).toEqual([
      { type: "camera_sample", position: [1, 2, 3], direction: [0, 0, 1], fov: 1.1 },
    ]);
    handle.stop();
  });

  it("attaches the bridge to a window global and removes it on stop", () => {
    const { ctx } = makeCtx();
    const handle = unityCollector().start(ctx)!;
    expect((globalThis as Record<string, unknown>).__uptimizr_unity__).toBeDefined();
    handle.stop();
    expect((globalThis as Record<string, unknown>).__uptimizr_unity__).toBeUndefined();
  });
});
