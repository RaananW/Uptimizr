import { describe, expect, it } from "vitest";
import { BRIDGE_PROTOCOL_VERSION } from "@uptimizr/web-export";
import type { CollectRequest, SceneProxy } from "@uptimizr/schema";
import type { CollectorContext, EventInput, Transport } from "@uptimizr/sdk-core";
import type { EngineBridge } from "@uptimizr/web-export";
import { UNITY_CONNECTOR_NAME, UNITY_FRAME, trackUnity, unityCollector } from "../index.js";

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

function mockTransport() {
  const batches: CollectRequest[] = [];
  const transport: Transport = {
    send: async (batch) => {
      batches.push(batch);
      return true;
    },
  };
  return { transport, batches };
}

describe("@uptimizr/unity", () => {
  it("declares Unity's native frame (left-handed, y-up, meters)", () => {
    expect(UNITY_FRAME).toEqual({ handedness: "left", upAxis: "y", unitScale: 1 });
  });

  it("names the collector 'unity'", () => {
    expect(unityCollector().name).toBe("unity");
    expect(UNITY_CONNECTOR_NAME).toBe("unity");
  });

  it("exposes a bridge implementing the foundation's protocol version", () => {
    const { ctx } = makeCtx();
    let bridge: EngineBridge | undefined;
    const handle = unityCollector({ onBridge: (b) => (bridge = b) }).start(ctx)!;
    expect(bridge?.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
    handle.stop();
  });

  it("emits a canonical (identity) camera_sample — Unity needs no axis conversion", () => {
    const { ctx, events } = makeCtx();
    let bridge: EngineBridge | undefined;
    const handle = unityCollector({ onBridge: (b) => (bridge = b) }).start(ctx)!;
    bridge!.pushPose([1, 2, 3], [0, 0, 1], [0, 1, 0], 1.1);
    expect(events).toEqual([
      { type: "camera_sample", position: [1, 2, 3], direction: [0, 0, 1], fov: 1.1 },
    ]);
    handle.stop();
  });

  it("emits a canonical (identity) mesh_interaction pick from the bridge", () => {
    const { ctx, events } = makeCtx();
    let bridge: EngineBridge | undefined;
    const handle = unityCollector({ onBridge: (b) => (bridge = b) }).start(ctx)!;
    bridge!.pushPick("Spaceship", [4, -5, 6]);
    expect(events).toEqual([
      { type: "mesh_interaction", mesh: "Spaceship", kind: "pick", point: [4, -5, 6] },
    ]);
    handle.stop();
  });

  it("emits a frame_perf from the bridge", () => {
    const { ctx, events } = makeCtx();
    let bridge: EngineBridge | undefined;
    const handle = unityCollector({ onBridge: (b) => (bridge = b) }).start(ctx)!;
    bridge!.pushPerf(58, 2);
    expect(events).toEqual([{ type: "frame_perf", fps: 58, longFrames: 2 }]);
    handle.stop();
  });

  it("builds a canonical (identity) scene proxy from native-frame AABBs", () => {
    const { ctx } = makeCtx();
    let bridge: EngineBridge | undefined;
    let proxy: SceneProxy | undefined;
    const handle = unityCollector({
      onBridge: (b) => (bridge = b),
      onSceneProxy: (p) => (proxy = p),
    }).start(ctx)!;
    bridge!.setSceneProxy([{ name: "Ground", aabb: [-1, -2, -3, 4, 5, 6] }]);
    expect(proxy).toBeDefined();
    // Unity is already canonical, so the proxy frame is unchanged and the box is identity.
    expect(proxy!.handedness).toBe("left");
    expect(proxy!.upAxis).toBe("y");
    expect(proxy!.unitScale).toBe(1);
    expect(proxy!.meshCount).toBe(1);
    expect(proxy!.meshes).toEqual([{ name: "Ground", aabb: [-1, -2, -3, 4, 5, 6] }]);
    expect(proxy!.bounds).toEqual([-1, -2, -3, 4, 5, 6]);
    handle.stop();
  });

  it("attaches the bridge to a window global and removes it on stop", () => {
    const { ctx } = makeCtx();
    const handle = unityCollector().start(ctx)!;
    expect((globalThis as Record<string, unknown>).__uptimizr_unity__).toBeDefined();
    handle.stop();
    expect((globalThis as Record<string, unknown>).__uptimizr_unity__).toBeUndefined();
  });

  it("records Unity's connector provenance on session_start via trackUnity", async () => {
    const { transport, batches } = mockTransport();
    const { client, bridge } = trackUnity({
      projectId: "proj_demo",
      endpoint: "https://collect.test",
      transport,
      flushIntervalMs: 0,
      version: "2022.3",
    });
    await client.flush();

    const start = batches.flatMap((b) => b.events).find((e) => e.type === "session_start");
    expect(start).toBeDefined();
    expect((start as { connector?: unknown }).connector).toEqual({
      name: "unity",
      version: "2022.3",
      coordinateSystem: { handedness: "left", upAxis: "y", unitScale: 1 },
    });
    // The bridge handed back is wired and on-protocol.
    expect(bridge?.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);

    await client.stop("manual");
  });
});
