import { describe, expect, it } from "vitest";
import type { CollectorContext, EventInput, Transport } from "@uptimizr/sdk-core";
import type { CollectRequest, SceneProxy } from "@uptimizr/schema";
import type { EngineBridge } from "@uptimizr/web-export";
import { UNREAL_CONNECTOR_NAME, UNREAL_FRAME, trackUnreal, unrealCollector } from "../index.js";

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

/** A transport that records every delivered batch so tests can inspect `session_start`. */
function capturingTransport(): { transport: Transport; batches: CollectRequest[] } {
  const batches: CollectRequest[] = [];
  return {
    batches,
    transport: {
      send: async (batch) => {
        batches.push(batch);
        return true;
      },
    },
  };
}

describe("@uptimizr/unreal", () => {
  it("declares Unreal's native frame (left-handed, z-up, centimeters)", () => {
    expect(UNREAL_FRAME).toEqual({ handedness: "left", upAxis: "z", unitScale: 100 });
  });

  it("names the collector 'unreal'", () => {
    expect(unrealCollector().name).toBe("unreal");
    expect(UNREAL_CONNECTOR_NAME).toBe("unreal");
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

  it("carries fov through and emits engine-measured perf samples", () => {
    const { ctx, events } = makeCtx();
    let bridge: EngineBridge | undefined;
    const handle = unrealCollector({ onBridge: (b) => (bridge = b) }).start(ctx)!;
    // direction is z-up native [0,1,0] → rebase (x,z,-y) → [0,0,-1]; fov passes through.
    bridge!.pushPose([0, 0, 0], [0, 1, 0], [0, 0, 1], 1.2);
    bridge!.pushPerf(60, 2);
    expect(events).toEqual([
      { type: "camera_sample", position: [0, 0, 0], direction: [0, 0, -1], fov: 1.2 },
      { type: "frame_perf", fps: 60, longFrames: 2 },
    ]);
    handle.stop();
  });

  it("rebases z-up→y-up and scales cm→m on a pushed scene-proxy AABB", () => {
    const { ctx } = makeCtx();
    let proxy: SceneProxy | undefined;
    let bridge: EngineBridge | undefined;
    const handle = unrealCollector({
      onBridge: (b) => (bridge = b),
      onSceneProxy: (p) => (proxy = p),
    }).start(ctx)!;
    // cm z-up [100,200,300,400,500,600] → /100 → [1,2,3,4,5,6] → rebase → [1,3,-5,4,6,-2]
    bridge!.setSceneProxy([{ name: "Wall", aabb: [100, 200, 300, 400, 500, 600] }]);
    expect(proxy).toBeDefined();
    expect(proxy!.upAxis).toBe("y");
    expect(proxy!.handedness).toBe("left");
    expect(proxy!.unitScale).toBe(1);
    expect(proxy!.meshes[0]).toEqual({ name: "Wall", aabb: [1, 3, -5, 4, 6, -2] });
    handle.stop();
  });

  it("attaches the bridge to a window global and removes it on stop", () => {
    const { ctx } = makeCtx();
    const handle = unrealCollector().start(ctx)!;
    expect((globalThis as Record<string, unknown>).__uptimizr_unreal__).toBeDefined();
    handle.stop();
    expect((globalThis as Record<string, unknown>).__uptimizr_unreal__).toBeUndefined();
  });

  it("records Unreal provenance — BOTH upAxis:'z' AND unitScale:100 — on session_start", async () => {
    const { transport, batches } = capturingTransport();
    const { client } = trackUnreal({
      projectId: "p1",
      endpoint: "https://collect.example.com",
      transport,
      flushIntervalMs: 0,
    });
    await client.stop("manual");

    const events = batches.flatMap((b) => b.events);
    const start = events.find((e) => e.type === "session_start");
    expect(start).toBeDefined();
    const connector = (start as { connector?: unknown }).connector as {
      name: string;
      coordinateSystem: { handedness: string; upAxis: string; unitScale: number };
    };
    expect(connector.name).toBe("unreal");
    expect(connector.coordinateSystem).toEqual({
      handedness: "left",
      upAxis: "z",
      unitScale: 100,
    });
  });
});
