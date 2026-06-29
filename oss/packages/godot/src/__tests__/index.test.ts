import { describe, expect, it } from "vitest";
import type { CollectorContext, EventInput, Transport } from "@uptimizr/sdk-core";
import type { CollectRequest, SessionStartEvent } from "@uptimizr/schema";
import type { EngineBridge } from "@uptimizr/web-export";
import { GODOT_FRAME, godotCollector, trackGodot } from "../index.js";

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

  it("normalizes a pushed pick by negating Z (RH → canonical LH)", () => {
    const { ctx, events } = makeCtx();
    let bridge: EngineBridge | undefined;
    const handle = godotCollector({ onBridge: (b) => (bridge = b) }).start(ctx)!;
    bridge!.pushPick("Crate", [4, 5, 6]);
    expect(events).toEqual([
      { type: "mesh_interaction", mesh: "Crate", kind: "pick", point: [4, 5, -6] },
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

  it("records Godot's native frame as connector provenance on session_start", async () => {
    const batches: CollectRequest[] = [];
    const transport: Transport = {
      send: (batch) => {
        batches.push(batch);
        return Promise.resolve(true);
      },
    };
    const { client } = trackGodot({
      projectId: "p1",
      endpoint: "https://collect.example.com",
      transport,
      flushIntervalMs: 0,
    });
    await client.flush();
    const start = batches
      .flatMap((b) => b.events)
      .find((e): e is SessionStartEvent => e.type === "session_start");
    expect(start).toBeDefined();
    expect(start?.connector).toEqual({
      name: "godot",
      coordinateSystem: { handedness: "right", upAxis: "y", unitScale: 1 },
    });
    await client.stop("manual");
  });
});
