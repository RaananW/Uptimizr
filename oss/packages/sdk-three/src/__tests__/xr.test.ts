import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AggregatorConfig, CollectorContext, Snapshot } from "@uptimizr/sdk-core";
import { createAggregator } from "@uptimizr/sdk-core";

import { xrCollector } from "../xr.js";
import type { XrRayProbe } from "../xr.js";

// Identity rotation + translation `t`, column-major (matches three's matrixWorld).
// With identity rotation the world forward is local −Z = (0, 0, −1).
function poseMatrix(t: [number, number, number]) {
  return {
    elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1],
  };
}

interface SessionListeners {
  [type: string]: Array<(event: { inputSource?: unknown }) => void>;
}

function makeXr() {
  const inputLeft = { handedness: "left", targetRayMode: "tracked-pointer" };
  const inputGaze = { handedness: "none", targetRayMode: "gaze" };
  const sessionListeners: SessionListeners = {};
  const session = {
    inputSources: [inputLeft, inputGaze],
    addEventListener: vi.fn((type: string, handler: (e: { inputSource?: unknown }) => void) => {
      (sessionListeners[type] ??= []).push(handler);
    }),
    removeEventListener: vi.fn((type: string, handler: (e: { inputSource?: unknown }) => void) => {
      const l = sessionListeners[type];
      if (!l) return;
      const i = l.indexOf(handler);
      if (i >= 0) l.splice(i, 1);
    }),
  };
  // index 0 → left controller at (1, 2, 3); index 1 → gaze at (0, 1, 0).
  const controllers = [poseMatrix([1, 2, 3]), poseMatrix([0, 1, 0])].map((m) => ({
    matrixWorld: m,
  }));
  const xrListeners: SessionListeners = {};
  const xr = {
    isPresenting: true,
    getSession: () => session,
    getController: (i: number) => controllers[i],
    addEventListener: vi.fn((type: string, handler: (e: unknown) => void) => {
      (xrListeners[type] ??= []).push(handler);
    }),
    removeEventListener: vi.fn((type: string, handler: (e: unknown) => void) => {
      const l = xrListeners[type];
      if (!l) return;
      const i = l.indexOf(handler);
      if (i >= 0) l.splice(i, 1);
    }),
  };
  return { xr, session, sessionListeners, xrListeners, inputLeft, inputGaze };
}

function makeCtx() {
  const emit = vi.fn();
  const ctx = {
    config: {} as CollectorContext["config"],
    sessionId: "sess_test",
    emit,
    track: vi.fn(),
    trackInput: vi.fn(),
    reportCapabilityChange: vi.fn(),
    setScene: vi.fn(),
    createAggregation: (config: AggregatorConfig) => {
      const aggregator = createAggregator({ ...config, emit: (e) => emit(e) });
      return (s: Snapshot) => aggregator.ingest(s);
    },
    now: () => 0,
  } as unknown as CollectorContext;
  return { ctx, emit };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("xrCollector — pose sampling", () => {
  it("emits a canonical pointer_move ray per input source, with source + handedness", () => {
    const { xr } = makeXr();
    const { ctx, emit } = makeCtx();
    const handle = xrCollector({ renderer: { xr }, sampleMs: 100 }).start(ctx);

    vi.advanceTimersByTime(100);

    expect(emit).toHaveBeenCalledTimes(2);
    const left = emit.mock.calls[0]![0];
    expect(left).toEqual({
      type: "pointer_move",
      source: "xr-controller",
      handedness: "left",
      sourceId: "left",
      // origin (1,2,3) and forward (0,0,-1) normalized to the canonical frame (−Z).
      ray: { origin: [1, 2, -3], direction: [0, 0, 1] },
    });

    const gaze = emit.mock.calls[1]![0];
    expect(gaze).toEqual({
      type: "pointer_move",
      source: "gaze",
      ray: { origin: [0, 1, 0], direction: [0, 0, 1] },
    });
    // Gaze has no paired hand, so neither handedness nor sourceId is set.
    expect(gaze).not.toHaveProperty("handedness");
    expect(gaze).not.toHaveProperty("sourceId");
    // Ray sources never carry a 2D screen position (ADR 0011).
    expect(left).not.toHaveProperty("screen");

    handle.stop();
  });

  it("attaches a hit (hitPoint/hitMesh) when a raycast probe is supplied", () => {
    const { xr } = makeXr();
    const { ctx, emit } = makeCtx();
    const raycast: XrRayProbe = () => ({ point: [4, 5, 6], name: "cube" });
    const handle = xrCollector({ renderer: { xr }, sampleMs: 100, raycast }).start(ctx);

    vi.advanceTimersByTime(100);

    const left = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(left.hitPoint).toEqual([4, 5, -6]);
    expect(left.hitMesh).toBe("cube");

    handle.stop();
  });
});

describe("xrCollector — discrete actions", () => {
  it("maps a controller select to a pointer_click and a mesh_interaction", () => {
    const { xr, sessionListeners, inputLeft } = makeXr();
    const { ctx, emit } = makeCtx();
    const raycast: XrRayProbe = () => ({ point: [4, 5, 6], name: "cube" });
    const handle = xrCollector({
      renderer: { xr },
      sampleMs: 100,
      capture: { pointerMove: false },
      raycast,
    }).start(ctx);

    // Fire the WebXR `select` event for the left controller.
    sessionListeners["select"]![0]!({ inputSource: inputLeft });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]![0]).toEqual({
      type: "pointer_click",
      source: "xr-controller",
      handedness: "left",
      sourceId: "left",
      ray: { origin: [1, 2, -3], direction: [0, 0, 1] },
      hitPoint: [4, 5, -6],
      hitMesh: "cube",
    });
    expect(emit.mock.calls[1]![0]).toEqual({
      type: "mesh_interaction",
      mesh: "cube",
      kind: "select",
      point: [4, 5, -6],
      source: "xr-controller",
      handedness: "left",
    });

    handle.stop();
  });

  it("maps a squeeze to a mesh_interaction (kind squeeze), without a pointer_click", () => {
    const { xr, sessionListeners, inputLeft } = makeXr();
    const { ctx, emit } = makeCtx();
    const raycast: XrRayProbe = () => ({ point: [4, 5, 6], name: "cube" });
    const handle = xrCollector({
      renderer: { xr },
      sampleMs: 100,
      capture: { pointerMove: false },
      raycast,
    }).start(ctx);

    sessionListeners["squeeze"]![0]!({ inputSource: inputLeft });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      type: "mesh_interaction",
      mesh: "cube",
      kind: "squeeze",
    });

    handle.stop();
  });

  it("emits only a pointer_click on select when no probe resolves a mesh", () => {
    const { xr, sessionListeners, inputLeft } = makeXr();
    const { ctx, emit } = makeCtx();
    const handle = xrCollector({
      renderer: { xr },
      sampleMs: 100,
      capture: { pointerMove: false },
    }).start(ctx);

    sessionListeners["select"]![0]!({ inputSource: inputLeft });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      type: "pointer_click",
      source: "xr-controller",
    });
    expect(emit.mock.calls[0]![0]).not.toHaveProperty("hitMesh");

    handle.stop();
  });
});

describe("xrCollector — lifecycle", () => {
  it("attaches when a session starts and detaches/cleans up on stop()", () => {
    const { xr, session, xrListeners, sessionListeners } = makeXr();
    xr.isPresenting = false; // not presenting at start
    const { ctx, emit } = makeCtx();
    const handle = xrCollector({ renderer: { xr }, sampleMs: 100 }).start(ctx);

    // No session yet: sampling has not begun.
    vi.advanceTimersByTime(100);
    expect(emit).not.toHaveBeenCalled();

    // A session starts → the collector attaches and begins sampling.
    xrListeners["sessionstart"]![0]!(undefined);
    expect(session.addEventListener).toHaveBeenCalledWith("select", expect.any(Function));
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(2);

    // stop() removes the session + manager listeners and clears the timer.
    handle.stop();
    expect(session.removeEventListener).toHaveBeenCalledWith("select", expect.any(Function));
    expect(session.removeEventListener).toHaveBeenCalledWith("squeeze", expect.any(Function));
    expect(xr.removeEventListener).toHaveBeenCalledWith("sessionstart", expect.any(Function));
    expect(xr.removeEventListener).toHaveBeenCalledWith("sessionend", expect.any(Function));

    emit.mockClear();
    vi.advanceTimersByTime(500);
    expect(emit).not.toHaveBeenCalled();
    expect(sessionListeners["select"]!.length).toBe(0);
  });

  it("detaches on sessionend (stops sampling)", () => {
    const { xr, xrListeners } = makeXr();
    const { ctx, emit } = makeCtx();
    const handle = xrCollector({ renderer: { xr }, sampleMs: 100 }).start(ctx);

    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(2);

    xrListeners["sessionend"]![0]!(undefined);
    emit.mockClear();
    vi.advanceTimersByTime(300);
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });
});
