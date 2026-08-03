import { describe, expect, it, vi } from "vitest";
import type { CollectorContext } from "@uptimizr/sdk-core";

import { babylonBoundaryCollector, distanceToBoundary } from "../boundaryProximity.js";

// A structural fake of a Babylon `Observable<T>`: records handlers and can `fire`.
function fakeObservable<T>() {
  const handlers: Array<(e: T) => void> = [];
  return {
    handlers,
    add: vi.fn((cb: (e: T) => void) => {
      handlers.push(cb);
      return cb;
    }),
    remove: vi.fn((observer: unknown) => {
      const i = handlers.indexOf(observer as (e: T) => void);
      if (i >= 0) handlers.splice(i, 1);
      return i >= 0;
    }),
    fire: (e: T) => handlers.slice().forEach((h) => h(e)),
  };
}

/** A 4×4-metre square play space centred on the origin (X/Z floor plane). */
const SQUARE_BOUNDS = [
  { x: -2, y: 0, z: -2 },
  { x: 2, y: 0, z: -2 },
  { x: 2, y: 0, z: 2 },
  { x: -2, y: 0, z: 2 },
];

/** A controllable session manager whose viewer pose we move between frames. */
function makeManager() {
  const onXRFrameObservable = fakeObservable<{
    getViewerPose?: (space: unknown) => { transform?: { position?: { x: number; y: number; z: number } } } | null;
  }>();
  const state = {
    pos: { x: 0, y: 1.6, z: 0 } as { x: number; y: number; z: number },
    bounds: SQUARE_BOUNDS as { x: number; y: number; z: number }[] | undefined,
  };
  const referenceSpace = {
    get boundsGeometry() {
      return state.bounds;
    },
  };
  const manager = {
    referenceSpace,
    onXRFrameObservable,
  };
  const frame = {
    getViewerPose: () => ({ transform: { position: state.pos } }),
  };
  return { manager, onXRFrameObservable, frame, state };
}

/** A ctx whose clock we advance manually so duration timing is deterministic. */
function makeCtx() {
  const emit = vi.fn();
  let clock = 0;
  const ctx = {
    config: {} as CollectorContext["config"],
    sessionId: "sess_test",
    emit,
    track: vi.fn(),
    trackInput: vi.fn(),
    reportCapabilityChange: vi.fn(),
    setScene: vi.fn(),
    setPositionProvider: vi.fn(),
    now: () => clock,
  } as unknown as CollectorContext;
  return { ctx, emit, advance: (ms: number) => (clock += ms) };
}

describe("distanceToBoundary", () => {
  it("returns the floor-plane distance to the nearest edge", () => {
    // Centre of a 4×4 square is 2 m from every edge.
    expect(distanceToBoundary(0, 0, SQUARE_BOUNDS)).toBeCloseTo(2);
    // 0.3 m inside the +X wall (x = 2).
    expect(distanceToBoundary(1.7, 0, SQUARE_BOUNDS)).toBeCloseTo(0.3);
  });

  it("ignores height (Y) — only the X/Z floor plane matters", () => {
    expect(distanceToBoundary(1.5, 0.5, SQUARE_BOUNDS)).toBeCloseTo(0.5);
  });

  it("returns Infinity when there is no usable boundary", () => {
    expect(distanceToBoundary(0, 0, [])).toBe(Infinity);
    expect(distanceToBoundary(0, 0, [{ x: 0, y: 0, z: 0 }])).toBe(Infinity);
  });
});

describe("babylonBoundaryCollector", () => {
  it("emits one xr_boundary_proximity per approach with closest position + duration", () => {
    const { manager, onXRFrameObservable, frame, state } = makeManager();
    const { ctx, emit, advance } = makeCtx();
    babylonBoundaryCollector({
      experience: { baseExperience: { sessionManager: manager } },
      nearMeters: 0.5,
      hysteresisMeters: 0.1,
      sampleMs: 0,
    }).start(ctx);

    // Far from the boundary → no approach.
    state.pos = { x: 0, y: 1.6, z: 0 };
    onXRFrameObservable.fire(frame);
    expect(emit).not.toHaveBeenCalled();

    // Enter the near zone (0.3 m from the +X wall at x=2).
    advance(100);
    state.pos = { x: 1.7, y: 1.6, z: 0 };
    onXRFrameObservable.fire(frame);
    // Move even closer (0.1 m) — this becomes the closest approach.
    advance(200);
    state.pos = { x: 1.9, y: 1.6, z: 0 };
    onXRFrameObservable.fire(frame);
    expect(emit).not.toHaveBeenCalled();

    // Retreat past the exit threshold (nearMeters + hysteresis = 0.6 m).
    advance(200);
    state.pos = { x: 0, y: 1.6, z: 0 };
    onXRFrameObservable.fire(frame);

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0]![0];
    expect(event.type).toBe("xr_boundary_proximity");
    // Closest approach was at x=1.9 (Babylon is left-handed → canonical copy).
    expect(event.position[0]).toBeCloseTo(1.9);
    expect(event.position[1]).toBeCloseTo(1.6);
    // In the zone from t=100 to t=500 → 400 ms.
    expect(event.durationMs).toBe(400);
  });

  it("does not emit while merely hovering at the threshold (hysteresis)", () => {
    const { manager, onXRFrameObservable, frame, state } = makeManager();
    const { ctx, emit, advance } = makeCtx();
    babylonBoundaryCollector({
      experience: { baseExperience: { sessionManager: manager } },
      nearMeters: 0.5,
      sampleMs: 0,
    }).start(ctx);

    state.pos = { x: 1.7, y: 1.6, z: 0 };
    onXRFrameObservable.fire(frame);
    // Retreat only to 0.55 m out — inside the hysteresis band, still an approach.
    advance(100);
    state.pos = { x: 1.45, y: 1.6, z: 0 };
    onXRFrameObservable.fire(frame);
    expect(emit).not.toHaveBeenCalled();
  });

  it("flushes an in-progress approach when the session stops", () => {
    const { manager, onXRFrameObservable, frame, state } = makeManager();
    const { ctx, emit, advance } = makeCtx();
    const handle = babylonBoundaryCollector({
      experience: { baseExperience: { sessionManager: manager } },
      nearMeters: 0.5,
      sampleMs: 0,
    }).start(ctx);

    state.pos = { x: 1.8, y: 1.6, z: 0 };
    onXRFrameObservable.fire(frame);
    advance(250);

    handle.stop();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0].durationMs).toBe(250);
    // The frame observer is removed on stop.
    expect(onXRFrameObservable.handlers).toHaveLength(0);
  });

  it("no-ops when the reference space is not a bounded-floor space", () => {
    const { manager, onXRFrameObservable, frame, state } = makeManager();
    const { ctx, emit } = makeCtx();
    state.bounds = undefined; // e.g. a plain local-floor space
    babylonBoundaryCollector({
      experience: { baseExperience: { sessionManager: manager } },
      sampleMs: 0,
    }).start(ctx);

    state.pos = { x: 1.9, y: 1.6, z: 0 };
    onXRFrameObservable.fire(frame);
    expect(emit).not.toHaveBeenCalled();
  });

  it("never emits the boundary geometry — only position + duration leave the device", () => {
    const { manager, onXRFrameObservable, frame, state } = makeManager();
    const { ctx, emit, advance } = makeCtx();
    babylonBoundaryCollector({
      experience: { baseExperience: { sessionManager: manager } },
      nearMeters: 0.5,
      sampleMs: 0,
    }).start(ctx);

    state.pos = { x: 1.9, y: 1.6, z: 0 };
    onXRFrameObservable.fire(frame);
    advance(100);
    state.pos = { x: 0, y: 1.6, z: 0 };
    onXRFrameObservable.fire(frame);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(Object.keys(emit.mock.calls[0]![0]).sort()).toEqual([
      "durationMs",
      "position",
      "type",
    ]);
  });

  it("does not throw when no session manager is present", () => {
    const { ctx } = makeCtx();
    const handle = babylonBoundaryCollector({ experience: {} }).start(ctx);
    expect(() => handle.stop()).not.toThrow();
  });
});
