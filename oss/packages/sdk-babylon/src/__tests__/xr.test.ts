import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CollectorContext } from "@uptimizr/sdk-core";

import { babylonXrCollector } from "../xr.js";
import type { XrRayProbe } from "../xr.js";

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

// Identity rotation + translation `t`, column-major (matches Babylon's matrix `.m`).
// With identity rotation the world forward is local +Z = (0, 0, 1) — Babylon is
// left-handed, so (unlike three) the forward column is NOT negated.
function poseNode(t: [number, number, number]) {
  return {
    getWorldMatrix: () => ({
      m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1],
    }),
  };
}

function makeComponent() {
  const obs = fakeObservable<{ pressed?: boolean }>();
  return { pressed: false, onButtonStateChangedObservable: obs };
}

function makeController(t: [number, number, number]) {
  const trigger = makeComponent();
  const squeeze = makeComponent();
  const motionController = {
    getComponentOfType: (type: string) =>
      type === "trigger" ? trigger : type === "squeeze" ? squeeze : null,
  };
  return {
    inputSource: { handedness: "left", targetRayMode: "tracked-pointer" },
    pointer: poseNode(t),
    motionController,
    onMotionControllerInitObservable: fakeObservable<typeof motionController>(),
    // expose components for the test to drive button presses
    _trigger: trigger,
    _squeeze: squeeze,
  };
}

function makeExperience(controllers: Array<ReturnType<typeof makeController>>) {
  const onControllerAddedObservable = fakeObservable<ReturnType<typeof makeController>>();
  const onControllerRemovedObservable = fakeObservable<ReturnType<typeof makeController>>();
  const input = {
    controllers,
    onControllerAddedObservable,
    onControllerRemovedObservable,
  };
  return { experience: { input }, input };
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

describe("babylonXrCollector — pose sampling", () => {
  it("emits a canonical pointer_move ray per controller, forward = +Z (no negate)", () => {
    const left = makeController([1, 2, 3]);
    const { experience } = makeExperience([left]);
    const { ctx, emit } = makeCtx();
    const handle = babylonXrCollector({ experience, sampleMs: 100 }).start(ctx);

    vi.advanceTimersByTime(100);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toEqual({
      type: "pointer_move",
      source: "xr-controller",
      handedness: "left",
      sourceId: "left",
      // Babylon is canonical (left-handed): origin and +Z forward pass through.
      ray: { origin: [1, 2, 3], direction: [0, 0, 1] },
    });
    // Ray sources never carry a 2D screen position (ADR 0011).
    expect(emit.mock.calls[0]![0]).not.toHaveProperty("screen");

    handle.stop();
  });

  it("attaches a hit (hitPoint/hitMesh) when a raycast probe is supplied", () => {
    const left = makeController([1, 2, 3]);
    const { experience } = makeExperience([left]);
    const { ctx, emit } = makeCtx();
    const raycast: XrRayProbe = () => ({ point: [4, 5, 6], name: "cube" });
    const handle = babylonXrCollector({ experience, sampleMs: 100, raycast }).start(ctx);

    vi.advanceTimersByTime(100);

    const move = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(move.hitPoint).toEqual([4, 5, 6]);
    expect(move.hitMesh).toBe("cube");

    handle.stop();
  });
});

describe("babylonXrCollector — discrete actions", () => {
  it("maps a trigger rising edge to a pointer_click and a mesh_interaction", () => {
    const left = makeController([1, 2, 3]);
    const { experience } = makeExperience([left]);
    const { ctx, emit } = makeCtx();
    const raycast: XrRayProbe = () => ({ point: [4, 5, 6], name: "cube" });
    const handle = babylonXrCollector({
      experience,
      sampleMs: 100,
      capture: { pointerMove: false },
      raycast,
    }).start(ctx);

    // Rising edge: pressed goes false → true.
    left._trigger.pressed = true;
    left._trigger.onButtonStateChangedObservable.fire({ pressed: true });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]![0]).toEqual({
      type: "pointer_click",
      source: "xr-controller",
      handedness: "left",
      sourceId: "left",
      ray: { origin: [1, 2, 3], direction: [0, 0, 1] },
      hitPoint: [4, 5, 6],
      hitMesh: "cube",
    });
    expect(emit.mock.calls[1]![0]).toEqual({
      type: "mesh_interaction",
      mesh: "cube",
      kind: "select",
      point: [4, 5, 6],
      source: "xr-controller",
      handedness: "left",
    });

    handle.stop();
  });

  it("does not re-fire while the trigger is held (no rising edge)", () => {
    const left = makeController([1, 2, 3]);
    const { experience } = makeExperience([left]);
    const { ctx, emit } = makeCtx();
    const handle = babylonXrCollector({
      experience,
      capture: { pointerMove: false },
    }).start(ctx);

    left._trigger.onButtonStateChangedObservable.fire({ pressed: true });
    left._trigger.onButtonStateChangedObservable.fire({ pressed: true }); // still held
    expect(emit).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it("maps a squeeze to a mesh_interaction (kind squeeze), without a pointer_click", () => {
    const left = makeController([1, 2, 3]);
    const { experience } = makeExperience([left]);
    const { ctx, emit } = makeCtx();
    const raycast: XrRayProbe = () => ({ point: [4, 5, 6], name: "cube" });
    const handle = babylonXrCollector({
      experience,
      capture: { pointerMove: false },
      raycast,
    }).start(ctx);

    left._squeeze.onButtonStateChangedObservable.fire({ pressed: true });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      type: "mesh_interaction",
      mesh: "cube",
      kind: "squeeze",
    });

    handle.stop();
  });

  it("emits only a pointer_click on select when no probe resolves a mesh", () => {
    const left = makeController([1, 2, 3]);
    const { experience } = makeExperience([left]);
    const { ctx, emit } = makeCtx();
    const handle = babylonXrCollector({
      experience,
      capture: { pointerMove: false },
    }).start(ctx);

    left._trigger.onButtonStateChangedObservable.fire({ pressed: true });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      type: "pointer_click",
      source: "xr-controller",
    });
    expect(emit.mock.calls[0]![0]).not.toHaveProperty("hitMesh");

    handle.stop();
  });
});

describe("babylonXrCollector — lifecycle", () => {
  it("hooks controllers added after start and unhooks them on removal", () => {
    const { experience, input } = makeExperience([]);
    const { ctx, emit } = makeCtx();
    const handle = babylonXrCollector({
      experience,
      capture: { pointerMove: false },
    }).start(ctx);

    // A controller appears mid-session → its trigger is wired.
    const added = makeController([1, 2, 3]);
    input.onControllerAddedObservable.fire(added);
    added._trigger.onButtonStateChangedObservable.fire({ pressed: true });
    expect(emit).toHaveBeenCalledTimes(1);

    // Once removed, its component subscription is torn down (no more emits).
    input.onControllerRemovedObservable.fire(added);
    expect(added._trigger.onButtonStateChangedObservable.remove).toHaveBeenCalled();
    emit.mockClear();
    added._trigger.onButtonStateChangedObservable.fire({ pressed: false });
    added._trigger.onButtonStateChangedObservable.fire({ pressed: true });
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });

  it("clears the timer and removes every observer on stop()", () => {
    const left = makeController([1, 2, 3]);
    const { experience, input } = makeExperience([left]);
    const { ctx, emit } = makeCtx();
    const handle = babylonXrCollector({ experience, sampleMs: 100 }).start(ctx);

    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(1);

    handle.stop();
    expect(input.onControllerAddedObservable.remove).toHaveBeenCalled();
    expect(input.onControllerRemovedObservable.remove).toHaveBeenCalled();
    expect(left._trigger.onButtonStateChangedObservable.remove).toHaveBeenCalled();
    expect(left._squeeze.onButtonStateChangedObservable.remove).toHaveBeenCalled();

    emit.mockClear();
    vi.advanceTimersByTime(500);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("babylonXrCollector — XR state gating", () => {
  it("samples pose only while IN_XR, auto-starting when the user enters XR later", () => {
    const left = makeController([1, 2, 3]);
    const { experience, input } = makeExperience([left]);
    // Attach a base experience with a state observable, starting NOT_IN_XR (3).
    const onStateChangedObservable = fakeObservable<number>();
    (experience as { baseExperience?: unknown }).baseExperience = {
      state: 3,
      onStateChangedObservable,
    };
    const { ctx, emit } = makeCtx();
    const handle = babylonXrCollector({ experience, sampleMs: 100 }).start(ctx);

    // Booted on desktop: no timer runs before entering XR.
    vi.advanceTimersByTime(300);
    expect(emit).not.toHaveBeenCalled();

    // User enters XR (IN_XR === 2): pose sampling begins.
    onStateChangedObservable.fire(2);
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(1);

    // User leaves XR: sampling stops.
    onStateChangedObservable.fire(3);
    emit.mockClear();
    vi.advanceTimersByTime(300);
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
    expect(input.onControllerAddedObservable.remove).toHaveBeenCalled();
  });

  it("starts sampling immediately when the experience is already IN_XR at start", () => {
    const left = makeController([1, 2, 3]);
    const { experience } = makeExperience([left]);
    (experience as { baseExperience?: unknown }).baseExperience = {
      state: 2, // already IN_XR
      onStateChangedObservable: fakeObservable<number>(),
    };
    const { ctx, emit } = makeCtx();
    const handle = babylonXrCollector({ experience, sampleMs: 100 }).start(ctx);

    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(1);

    handle.stop();
  });
});
