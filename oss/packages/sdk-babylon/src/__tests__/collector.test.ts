import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scene } from "@babylonjs/core";
import type { AggregatorConfig, CollectorContext, EventInput, Snapshot } from "@uptimizr/sdk-core";
import { createAggregator } from "@uptimizr/sdk-core";
import { babylonCollector } from "../collector.js";
import { readDeviceCaps } from "../device.js";
import { classifyCamera, readSceneMeta } from "../scene.js";

class FakeObservable<T> {
  observers: Array<(e: T) => void> = [];
  add(cb: (e: T) => void) {
    this.observers.push(cb);
    return cb as unknown as never;
  }
  remove(o: unknown) {
    this.observers = this.observers.filter((cb) => (cb as unknown) !== o);
    return true;
  }
  trigger(e: T) {
    for (const cb of this.observers) cb(e);
  }
}

const POINTER_MOVE = 0x04;
const POINTER_PICK = 0x10;
const POINTER_TAP = 0x20;
const POINTER_DOWN = 0x01;
const POINTER_UP = 0x02;
const KEY_DOWN = 0x01;
const KEY_UP = 0x02;

function makeEngine() {
  return {
    getFps: () => 60,
    getRenderWidth: () => 800,
    getRenderHeight: () => 600,
    isWebGPU: false,
    webGLVersion: 2,
    getGlInfo: () => ({ vendor: "Acme", renderer: "GPU-9000" }),
    getCaps: () => ({ maxTextureSize: 8192 }),
    getAspectRatio: () => 800 / 600,
    onContextLostObservable: new FakeObservable<unknown>(),
    onContextRestoredObservable: new FakeObservable<unknown>(),
    onBeforeShaderCompilationObservable: new FakeObservable<unknown>(),
    onAfterShaderCompilationObservable: new FakeObservable<unknown>(),
  };
}

function makeScene() {
  const onPointerObservable = new FakeObservable<unknown>();
  const onKeyboardObservable = new FakeObservable<unknown>();
  const onBeforeRenderObservable = new FakeObservable<unknown>();
  const engine = makeEngine();
  const scene = {
    activeCamera: {
      globalPosition: { x: 1, y: 2, z: 3 },
      getForwardRay: () => ({ direction: { x: 0, y: 0, z: 1 } }),
      fov: 0.8,
      minZ: 0.1,
      getTarget: () => ({ x: 0, y: 0, z: 0 }),
    },
    pointerX: 400,
    pointerY: 300,
    onPointerObservable,
    onKeyboardObservable,
    onBeforeRenderObservable,
    getActiveIndices: () => 360_000,
    getTotalVertices: () => 90_000,
    getEngine: () => engine,
  };
  return {
    scene: scene as unknown as Scene,
    onPointerObservable,
    onKeyboardObservable,
    onBeforeRenderObservable,
    engine,
  };
}

function makeCtx(now = { value: 1000 }) {
  const events: EventInput[] = [];
  const ctx = {
    config: {} as never,
    sessionId: "s1",
    emit: (e: EventInput) => events.push(e),
    track: () => {},
    trackInput: (
      action: string,
      opts: { source?: string; code?: string; button?: number; pressed?: boolean } = {},
    ) =>
      events.push({
        type: "input_action",
        action,
        source: opts.source ?? "keyboard",
        ...(opts.code ? { code: opts.code } : {}),
        ...(typeof opts.button === "number" ? { button: opts.button } : {}),
        ...(typeof opts.pressed === "boolean" ? { pressed: opts.pressed } : {}),
      } as EventInput),
    setScene: () => {},
    createAggregation: (config: AggregatorConfig) => {
      // Mirror production: snapshots flow through a real main-thread aggregator
      // whose finalized events land in the same `events` sink, so the existing
      // event-shape assertions exercise the snapshot → aggregator → emit path.
      const aggregator = createAggregator({ ...config, emit: (e) => events.push(e) });
      return (s: Snapshot) => aggregator.ingest(s);
    },
    now: () => now.value,
  } satisfies CollectorContext;
  return { ctx, events, now };
}

describe("babylonCollector", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits an initial camera_sample with pose", () => {
    const { scene } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample");
    expect(cam).toMatchObject({
      type: "camera_sample",
      position: [1, 2, 3],
      direction: [0, 0, 1],
      target: [0, 0, 0],
      fov: 0.8,
    });
    handle.stop();
  });

  it("captures camera projection intrinsics (fov/aspect/near) on camera_sample (#22)", () => {
    const { scene } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample");
    expect(cam).toMatchObject({
      type: "camera_sample",
      fov: 0.8,
      aspect: 800 / 600,
      near: 0.1,
    });
    handle.stop();
  });

  it("omits aspect/near when the engine/camera don't expose them (#22)", () => {
    const { scene } = makeScene();
    const mutableCam = (scene as unknown as { activeCamera: Record<string, unknown> }).activeCamera;
    delete mutableCam.minZ;
    (scene as unknown as { getEngine: () => Record<string, unknown> }).getEngine = () => ({
      getFps: () => 60,
      getRenderWidth: () => 800,
      getRenderHeight: () => 600,
    });
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample");
    expect(cam).not.toHaveProperty("aspect");
    expect(cam).not.toHaveProperty("near");
    handle.stop();
  });

  it("attaches a gaze hit-point to camera_sample when gaze capture is enabled (ADR 0030)", () => {
    const { scene } = makeScene();
    (scene as unknown as { pickWithRay: unknown }).pickWithRay = () => ({
      hit: true,
      pickedPoint: { x: 4, y: 5, z: 6 },
      pickedMesh: { name: "Wall" },
    });
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { perf: false, gaze: true } }).start(ctx)!;

    expect(events.find((e) => e.type === "camera_sample")).toMatchObject({
      type: "camera_sample",
      hitPoint: [4, 5, 6],
      hitMesh: "Wall",
    });
    handle.stop();
  });

  it("omits gaze fields when gaze capture is disabled", () => {
    const { scene } = makeScene();
    const pick = vi.fn(() => ({
      hit: true,
      pickedPoint: { x: 4, y: 5, z: 6 },
      pickedMesh: { name: "Wall" },
    }));
    (scene as unknown as { pickWithRay: unknown }).pickWithRay = pick;
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample");
    expect(cam).not.toHaveProperty("hitPoint");
    expect(cam).not.toHaveProperty("hitMesh");
    expect(pick).not.toHaveBeenCalled();
    handle.stop();
  });

  it("leaves gaze fields unset on a ray miss", () => {
    const { scene } = makeScene();
    (scene as unknown as { pickWithRay: unknown }).pickWithRay = () => ({ hit: false });
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { perf: false, gaze: true } }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample");
    expect(cam).not.toHaveProperty("hitPoint");
    expect(cam).not.toHaveProperty("hitMesh");
    handle.stop();
  });

  it("records the explicit camera instead of scene.activeCamera", () => {
    const { scene } = makeScene();
    const explicit = {
      globalPosition: { x: 7, y: 8, z: 9 },
      getForwardRay: () => ({ direction: { x: 1, y: 0, z: 0 } }),
      getTarget: () => ({ x: 8, y: 8, z: 9 }),
    } as unknown as Parameters<typeof babylonCollector>[0]["camera"];
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, camera: explicit, capture: { perf: false } }).start(
      ctx,
    )!;

    expect(events.find((e) => e.type === "camera_sample")).toMatchObject({
      position: [7, 8, 9],
      direction: [1, 0, 0],
    });
    handle.stop();
  });

  it("falls back to activeCameras[0] when activeCamera is null (multi-camera rig)", () => {
    const { scene } = makeScene();
    const rigCam = {
      name: "main",
      globalPosition: { x: 5, y: 0, z: 0 },
      getForwardRay: () => ({ direction: { x: -1, y: 0, z: 0 } }),
      getTarget: () => ({ x: 0, y: 0, z: 0 }),
    };
    const mutable = scene as unknown as {
      activeCamera: unknown;
      activeCameras: unknown[];
    };
    mutable.activeCamera = null;
    mutable.activeCameras = [rigCam, { name: "inset" }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

    expect(events.find((e) => e.type === "camera_sample")).toMatchObject({
      position: [5, 0, 0],
      direction: [-1, 0, 0],
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    handle.stop();
  });

  it("emits throttled pointer_move with normalized screen and pick", () => {
    const { scene, onPointerObservable } = makeScene();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = babylonCollector({ scene, pointerMoveThrottleMs: 250 }).start(ctx)!;

    const move = {
      type: POINTER_MOVE,
      event: {},
      pickInfo: { hit: true, pickedPoint: { x: 4, y: 5, z: 6 }, pickedMesh: { name: "Cube" } },
    };
    onPointerObservable.trigger(move);
    onPointerObservable.trigger(move); // within throttle window → dropped
    now.value = 1300;
    onPointerObservable.trigger(move); // after window → emitted

    const moves = events.filter((e) => e.type === "pointer_move");
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({ screen: [0.5, 0.5], hitMesh: "Cube", hitPoint: [4, 5, 6] });
    handle.stop();
  });

  it("emits pointer_click on tap with button", () => {
    const { scene, onPointerObservable } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene }).start(ctx)!;

    onPointerObservable.trigger({ type: POINTER_TAP, event: { button: 0 }, pickInfo: null });
    expect(events.find((e) => e.type === "pointer_click")).toMatchObject({
      type: "pointer_click",
      screen: [0.5, 0.5],
      button: 0,
    });
    handle.stop();
  });

  it("reports the crosshair (centre) and re-picks at the viewport centre while pointer-locked (ADR 0034)", () => {
    const { scene, onPointerObservable, engine } = makeScene();
    // Stale cursor far from centre — locked it must be ignored in favour of centre.
    (scene as unknown as { pointerX: number; pointerY: number }).pointerX = 700;
    (scene as unknown as { pointerX: number; pointerY: number }).pointerY = 100;
    const canvas = { id: "render-canvas" };
    (engine as unknown as { getRenderingCanvas: () => unknown }).getRenderingCanvas = () => canvas;
    const pick = vi.fn(() => ({
      hit: true,
      pickedPoint: { x: 1, y: 1, z: 1 },
      pickedMesh: { name: "Exhibit" },
    }));
    (scene as unknown as { pick: unknown }).pick = pick;
    const { ctx, events } = makeCtx();

    const prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { pointerLockElement: canvas };
    try {
      const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

      onPointerObservable.trigger({ type: POINTER_TAP, event: { button: 0 }, pickInfo: null });

      expect(events.find((e) => e.type === "pointer_click")).toMatchObject({
        type: "pointer_click",
        screen: [0.5, 0.5],
        hitMesh: "Exhibit",
        hitPoint: [1, 1, 1],
      });
      // Re-picked at the render-target centre (800/2, 600/2), not the stale cursor.
      expect(pick).toHaveBeenCalledWith(400, 300);
      handle.stop();
    } finally {
      if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = prevDoc;
    }
  });

  it("emits a camera_gesture when the view turns between pointer down and up (ADR 0025)", () => {
    const { scene, onPointerObservable } = makeScene();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    // An arc-rotate-style camera: explicit pivot (target) + distance (radius).
    const cam = {
      globalPosition: { x: 0, y: 0, z: -10 },
      getForwardRay: () => ({ direction: { ...cam.forward } }),
      getTarget: () => ({ x: 0, y: 0, z: 0 }),
      upVector: { x: 0, y: 1, z: 0 },
      radius: 10,
      fov: 0.8,
      forward: { x: 0, y: 0, z: 1 },
    };
    (scene as unknown as { activeCamera: unknown }).activeCamera = cam;
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

    onPointerObservable.trigger({ type: POINTER_DOWN, event: { button: 0 }, pickInfo: null });
    // Orbit the view ~45° around the pivot before releasing.
    cam.forward = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
    now.value = 1400;
    onPointerObservable.trigger({ type: POINTER_UP, event: { button: 0 }, pickInfo: null });

    const gesture = events.find((e) => e.type === "camera_gesture");
    expect(gesture).toMatchObject({ type: "camera_gesture", kind: "orbit", durationMs: 400 });
    expect((gesture as { orbitDeg: number }).orbitDeg).toBeGreaterThan(40);
    expect(gesture).not.toHaveProperty("mesh");
    handle.stop();
  });

  it("does not emit a camera_gesture when the camera holds still through a press", () => {
    const { scene, onPointerObservable } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

    onPointerObservable.trigger({ type: POINTER_DOWN, event: { button: 0 }, pickInfo: null });
    onPointerObservable.trigger({ type: POINTER_UP, event: { button: 0 }, pickInfo: null });

    expect(events.some((e) => e.type === "camera_gesture")).toBe(false);
    handle.stop();
  });

  it("does not capture camera_gesture when disabled", () => {
    const { scene, onPointerObservable } = makeScene();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const cam = {
      globalPosition: { x: 0, y: 0, z: -10 },
      getForwardRay: () => ({ direction: { ...cam.forward } }),
      getTarget: () => ({ x: 0, y: 0, z: 0 }),
      radius: 10,
      forward: { x: 0, y: 0, z: 1 },
    };
    (scene as unknown as { activeCamera: unknown }).activeCamera = cam;
    const handle = babylonCollector({
      scene,
      capture: { perf: false, cameraGesture: false },
    }).start(ctx)!;

    onPointerObservable.trigger({ type: POINTER_DOWN, event: { button: 0 }, pickInfo: null });
    cam.forward = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
    onPointerObservable.trigger({ type: POINTER_UP, event: { button: 0 }, pickInfo: null });

    expect(events.some((e) => e.type === "camera_gesture")).toBe(false);
    handle.stop();
  });

  it("maps the DOM pointerType to an input source (ADR 0011)", () => {
    const { scene, onPointerObservable } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene }).start(ctx)!;

    onPointerObservable.trigger({
      type: POINTER_TAP,
      event: { button: 0, pointerType: "touch" },
      pickInfo: null,
    });
    onPointerObservable.trigger({
      type: POINTER_TAP,
      event: { button: 0, pointerType: "pen" },
      pickInfo: null,
    });
    onPointerObservable.trigger({
      type: POINTER_TAP,
      event: { button: 0, pointerType: "wand" },
      pickInfo: null,
    });
    onPointerObservable.trigger({ type: POINTER_TAP, event: { button: 0 }, pickInfo: null });

    const clicks = events.filter((e) => e.type === "pointer_click");
    expect(clicks[0]).toMatchObject({ source: "touch" });
    expect(clicks[1]).toMatchObject({ source: "pen" });
    expect(clicks[2]).toMatchObject({ source: "other" });
    expect(clicks[3]).not.toHaveProperty("source");
    handle.stop();
  });

  it("emits pointer_down and pointer_up with the button", () => {
    const { scene, onPointerObservable } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene }).start(ctx)!;

    onPointerObservable.trigger({ type: POINTER_DOWN, event: { button: 2 }, pickInfo: null });
    onPointerObservable.trigger({ type: POINTER_UP, event: { button: 2 }, pickInfo: null });

    expect(events.find((e) => e.type === "pointer_down")).toMatchObject({
      type: "pointer_down",
      screen: [0.5, 0.5],
      button: 2,
    });
    expect(events.find((e) => e.type === "pointer_up")).toMatchObject({
      type: "pointer_up",
      screen: [0.5, 0.5],
      button: 2,
    });
    handle.stop();
  });

  it("captures only allowlisted keys as input_action, mapping code to the bound action", () => {
    const { scene, onKeyboardObservable } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      keyBindings: { KeyN: "next-camera" },
    }).start(ctx)!;

    // Bound key down -> mapped action, pressed true.
    onKeyboardObservable.trigger({ type: KEY_DOWN, event: { code: "KeyN", repeat: false } });
    // Bound key up -> pressed false.
    onKeyboardObservable.trigger({ type: KEY_UP, event: { code: "KeyN", repeat: false } });
    // Auto-repeat down is dropped.
    onKeyboardObservable.trigger({ type: KEY_DOWN, event: { code: "KeyN", repeat: true } });
    // Unbound key is ignored.
    onKeyboardObservable.trigger({ type: KEY_DOWN, event: { code: "KeyZ", repeat: false } });

    const inputs = events.filter((e) => e.type === "input_action");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      type: "input_action",
      action: "next-camera",
      source: "keyboard",
      code: "KeyN",
      pressed: true,
    });
    expect(inputs[1]).toMatchObject({ action: "next-camera", pressed: false });
    handle.stop();
  });

  it("does not subscribe to keyboard when no keyBindings are provided", () => {
    const { scene, onKeyboardObservable } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene }).start(ctx)!;

    expect(onKeyboardObservable.observers).toHaveLength(0);
    onKeyboardObservable.trigger({ type: KEY_DOWN, event: { code: "KeyN", repeat: false } });
    expect(events.some((e) => e.type === "input_action")).toBe(false);
    handle.stop();
  });

  it("removes the keyboard observer on stop", () => {
    const { scene, onKeyboardObservable } = makeScene();
    const { ctx } = makeCtx();
    const handle = babylonCollector({ scene, keyBindings: { KeyN: "next" } }).start(ctx)!;
    expect(onKeyboardObservable.observers).toHaveLength(1);
    handle.stop();
    expect(onKeyboardObservable.observers).toHaveLength(0);
  });

  it("does not emit button events when the buttons channel is off", () => {
    const { scene, onPointerObservable } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { buttons: false } }).start(ctx)!;

    onPointerObservable.trigger({ type: POINTER_DOWN, event: { button: 0 }, pickInfo: null });
    onPointerObservable.trigger({ type: POINTER_UP, event: { button: 0 }, pickInfo: null });

    expect(events.some((e) => e.type === "pointer_down" || e.type === "pointer_up")).toBe(false);
    handle.stop();
  });

  it("emits mesh_interaction on pick", () => {
    const { scene, onPointerObservable } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene }).start(ctx)!;

    onPointerObservable.trigger({
      type: POINTER_PICK,
      event: {},
      pickInfo: { hit: true, pickedPoint: { x: 7, y: 8, z: 9 }, pickedMesh: { name: "Door" } },
    });
    expect(events.find((e) => e.type === "mesh_interaction")).toMatchObject({
      type: "mesh_interaction",
      mesh: "Door",
      kind: "pick",
      point: [7, 8, 9],
    });
    handle.stop();
  });

  it("samples frame_perf on the perf interval and stops cleanly", () => {
    const { scene, onPointerObservable } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      samplePerfMs: 2000,
      capture: { camera: false },
    }).start(ctx)!;

    vi.advanceTimersByTime(2000);
    expect(events.some((e) => e.type === "frame_perf")).toBe(true);

    handle.stop();
    const before = events.length;
    onPointerObservable.trigger({ type: POINTER_TAP, event: { button: 0 }, pickInfo: null });
    vi.advanceTimersByTime(4000);
    expect(events.length).toBe(before); // no events after stop
  });

  it("suppresses idle camera_sample when the pose is unchanged", () => {
    const { scene } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      sampleCameraMs: 1000,
      capture: { perf: false },
    }).start(ctx)!;

    // Initial sample emitted; subsequent ticks with a static camera are dropped.
    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(1);

    // Move the camera → next tick emits again.
    (scene.activeCamera as unknown as { globalPosition: { x: number } }).globalPosition.x = 9;
    vi.advanceTimersByTime(1000);
    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(2);
    handle.stop();
  });

  it("keeps emitting idle camera_sample when suppression is disabled", () => {
    const { scene } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      sampleCameraMs: 1000,
      suppressIdleSamples: false,
      capture: { perf: false },
    }).start(ctx)!;

    vi.advanceTimersByTime(3000);
    expect(events.filter((e) => e.type === "camera_sample").length).toBeGreaterThanOrEqual(4);
    handle.stop();
  });

  it("keeps emitting frame_perf on a steady FPS by default", () => {
    const { scene } = makeScene();
    const engine = scene.getEngine() as unknown as { getFps: () => number };
    engine.getFps = () => 60; // perfectly steady
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      samplePerfMs: 1000,
      capture: { camera: false },
    }).start(ctx)!;

    vi.advanceTimersByTime(3000); // steady 60 fps still reports every tick
    expect(events.filter((e) => e.type === "frame_perf")).toHaveLength(3);
    handle.stop();
  });

  it("suppresses frame_perf when FPS is steady and suppression is opted in", () => {
    const { scene } = makeScene();
    const engine = scene.getEngine() as unknown as { getFps: () => number };
    let fps = 60;
    engine.getFps = () => fps;
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      samplePerfMs: 1000,
      suppressIdlePerfSamples: true,
      perfFpsThreshold: 1,
      capture: { camera: false },
    }).start(ctx)!;

    vi.advanceTimersByTime(1000); // first perf sample (baseline)
    expect(events.filter((e) => e.type === "frame_perf")).toHaveLength(1);
    vi.advanceTimersByTime(2000); // steady 60 fps → suppressed
    expect(events.filter((e) => e.type === "frame_perf")).toHaveLength(1);

    fps = 30; // big drop → emitted
    vi.advanceTimersByTime(1000);
    expect(events.filter((e) => e.type === "frame_perf")).toHaveLength(2);
    handle.stop();
  });

  it("reports jank percentiles and render resolution in frame_perf (#41, #43)", () => {
    const { scene, onBeforeRenderObservable } = makeScene();
    const engine = scene.getEngine() as unknown as {
      getDeltaTime: () => number;
      getHardwareScalingLevel: () => number;
    };
    let dt = 16;
    engine.getDeltaTime = () => dt;
    engine.getHardwareScalingLevel = () => 2; // half-res → renderScale 0.5
    const globals = globalThis as { devicePixelRatio?: number };
    const priorDpr = globals.devicePixelRatio;
    globals.devicePixelRatio = 3;
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      samplePerfMs: 1000,
      jankFrameMs: 50,
      capture: { camera: false },
    }).start(ctx)!;

    // A window of 20 frames: 18 smooth (16ms) and 2 long (80ms, 120ms).
    for (let i = 0; i < 18; i++) {
      dt = 16;
      onBeforeRenderObservable.trigger({});
    }
    dt = 80;
    onBeforeRenderObservable.trigger({});
    dt = 120;
    onBeforeRenderObservable.trigger({});
    vi.advanceTimersByTime(1000);

    const perf = events.find((e) => e.type === "frame_perf") as unknown as Record<string, number>;
    expect(perf.longFrames).toBe(2);
    expect(perf.frameTimeP95Ms).toBe(80);
    expect(perf.frameTimeP99Ms).toBe(120);
    expect(perf.renderScale).toBeCloseTo(0.5);
    expect(perf.dpr).toBe(3);

    if (priorDpr === undefined) delete globals.devicePixelRatio;
    else globals.devicePixelRatio = priorDpr;
    handle.stop();
  });

  it("emits one bucketed mesh_visibility summary per visible object per window (#37)", () => {
    const { scene, onBeforeRenderObservable } = makeScene();
    const engine = scene.getEngine() as unknown as { getDeltaTime: () => number };
    engine.getDeltaTime = () => 16;
    // Camera is at (1,2,3) looking down +z. One mesh ahead, one behind.
    (scene as unknown as { meshes: unknown[] }).meshes = [
      {
        name: "product-hero",
        isEnabled: () => true,
        getTotalVertices: () => 100,
        getBoundingInfo: () => ({
          boundingBox: {
            minimumWorld: { x: 0.5, y: 1.5, z: 13 },
            maximumWorld: { x: 1.5, y: 2.5, z: 15 },
          },
        }),
      },
      {
        name: "backdrop",
        isEnabled: () => true,
        getTotalVertices: () => 100,
        getBoundingInfo: () => ({
          boundingBox: {
            minimumWorld: { x: 0, y: 0, z: -10 },
            maximumWorld: { x: 1, y: 1, z: -8 },
          },
        }),
      },
    ];
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { meshVisibility: true, camera: false, perf: false },
      meshVisibility: { windowMs: 1000 },
    }).start(ctx)!;

    for (let i = 0; i < 10; i++) onBeforeRenderObservable.trigger({});
    vi.advanceTimersByTime(1000);

    const vis = events.filter((e) => e.type === "mesh_visibility");
    // Only the mesh in front of the camera is visible (forward half-space test).
    expect(vis).toHaveLength(1);
    expect(vis[0]).toMatchObject({ type: "mesh_visibility", mesh: "product-hero" });
    expect((vis[0] as unknown as { visibleMs: number }).visibleMs).toBe(160);
    expect((vis[0] as unknown as { centeredMs: number }).centeredMs).toBe(160);

    handle.stop();
  });

  it("rides the world AABB along once per object when boundingBox is on (#53)", () => {
    const { scene, onBeforeRenderObservable } = makeScene();
    (scene.getEngine() as unknown as { getDeltaTime: () => number }).getDeltaTime = () => 16;
    (scene as unknown as { meshes: unknown[] }).meshes = [
      {
        name: "product-hero",
        isEnabled: () => true,
        getTotalVertices: () => 100,
        getBoundingInfo: () => ({
          boundingBox: {
            minimumWorld: { x: 0.5, y: 1.5, z: 13 },
            maximumWorld: { x: 1.5, y: 2.5, z: 15 },
          },
        }),
      },
    ];
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { meshVisibility: true, camera: false, perf: false },
      meshVisibility: { windowMs: 1000, boundingBox: true },
    }).start(ctx)!;

    // First window: bounds ride along.
    for (let i = 0; i < 5; i++) onBeforeRenderObservable.trigger({});
    vi.advanceTimersByTime(1000);
    // Second window: bounds unchanged, so they are NOT re-sent.
    for (let i = 0; i < 5; i++) onBeforeRenderObservable.trigger({});
    vi.advanceTimersByTime(1000);

    const vis = events.filter((e) => e.type === "mesh_visibility") as unknown as {
      mesh: string;
      bounds?: number[];
    }[];
    expect(vis).toHaveLength(2);
    expect(vis[0]!.bounds).toEqual([0.5, 1.5, 13, 1.5, 2.5, 15]);
    expect(vis[1]!.bounds).toBeUndefined();

    handle.stop();
  });

  it("omits the AABB unless boundingBox capture is enabled (#53)", () => {
    const { scene, onBeforeRenderObservable } = makeScene();
    (scene.getEngine() as unknown as { getDeltaTime: () => number }).getDeltaTime = () => 16;
    (scene as unknown as { meshes: unknown[] }).meshes = [
      {
        name: "product-hero",
        isEnabled: () => true,
        getTotalVertices: () => 100,
        getBoundingInfo: () => ({
          boundingBox: {
            minimumWorld: { x: 0.5, y: 1.5, z: 13 },
            maximumWorld: { x: 1.5, y: 2.5, z: 15 },
          },
        }),
      },
    ];
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { meshVisibility: true, camera: false, perf: false },
      meshVisibility: { windowMs: 1000 },
    }).start(ctx)!;

    for (let i = 0; i < 5; i++) onBeforeRenderObservable.trigger({});
    vi.advanceTimersByTime(1000);

    const vis = events.filter((e) => e.type === "mesh_visibility") as unknown as {
      bounds?: number[];
    }[];
    expect(vis).toHaveLength(1);
    expect(vis[0]!.bounds).toBeUndefined();

    handle.stop();
  });

  it("does not capture mesh_visibility unless explicitly enabled (#37, ADR 0003)", () => {
    const { scene, onBeforeRenderObservable } = makeScene();
    (scene.getEngine() as unknown as { getDeltaTime: () => number }).getDeltaTime = () => 16;
    (scene as unknown as { meshes: unknown[] }).meshes = [
      {
        name: "product-hero",
        isEnabled: () => true,
        getTotalVertices: () => 100,
        getBoundingInfo: () => ({
          boundingBox: {
            minimumWorld: { x: 0.5, y: 1.5, z: 13 },
            maximumWorld: { x: 1.5, y: 2.5, z: 15 },
          },
        }),
      },
    ];
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { camera: false, perf: false } }).start(ctx)!;

    for (let i = 0; i < 10; i++) onBeforeRenderObservable.trigger({});
    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "mesh_visibility")).toBe(false);
    handle.stop();
  });

  it("emits a hover_dwell summary when the pointer lingers on an object then leaves (#48)", () => {
    const { scene, onPointerObservable } = makeScene();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = babylonCollector({
      scene,
      capture: { camera: false, perf: false, hoverDwell: true },
      hoverDwell: { minDwellMs: 500 },
    }).start(ctx)!;

    const over = (name: string) => ({
      type: POINTER_MOVE,
      event: { pointerType: "mouse" },
      pickInfo: { hit: true, pickedMesh: { name } },
    });
    // Hover onto "Cube" at T0, linger, then move onto "Sphere" at T0+800ms.
    onPointerObservable.trigger(over("Cube"));
    now.value = 1800;
    onPointerObservable.trigger(over("Sphere"));

    const hovers = events.filter((e) => e.type === "hover_dwell");
    expect(hovers).toHaveLength(1);
    expect(hovers[0]).toMatchObject({
      type: "hover_dwell",
      mesh: "Cube",
      dwellMs: 800,
      source: "mouse",
    });
    handle.stop();
  });

  it("suppresses hover_dwell when the lingered object is clicked (#48)", () => {
    const { scene, onPointerObservable } = makeScene();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = babylonCollector({
      scene,
      capture: { camera: false, perf: false, hoverDwell: true },
      hoverDwell: { minDwellMs: 500 },
    }).start(ctx)!;

    const cube = { hit: true, pickedMesh: { name: "Cube" } };
    onPointerObservable.trigger({ type: POINTER_MOVE, event: {}, pickInfo: cube });
    now.value = 1800;
    // A click on the hovered object marks it as an action, not hesitation.
    onPointerObservable.trigger({ type: POINTER_TAP, event: { button: 0 }, pickInfo: cube });
    now.value = 2000;
    onPointerObservable.trigger({ type: POINTER_MOVE, event: {}, pickInfo: { hit: false } });

    expect(events.some((e) => e.type === "hover_dwell")).toBe(false);
    handle.stop();
  });

  it("drops hover episodes shorter than minDwellMs (#48)", () => {
    const { scene, onPointerObservable } = makeScene();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = babylonCollector({
      scene,
      capture: { camera: false, perf: false, hoverDwell: true },
      hoverDwell: { minDwellMs: 500 },
    }).start(ctx)!;

    onPointerObservable.trigger({
      type: POINTER_MOVE,
      event: {},
      pickInfo: { hit: true, pickedMesh: { name: "Cube" } },
    });
    now.value = 1200; // only 200ms < 500ms threshold
    onPointerObservable.trigger({
      type: POINTER_MOVE,
      event: {},
      pickInfo: { hit: true, pickedMesh: { name: "Sphere" } },
    });

    expect(events.some((e) => e.type === "hover_dwell")).toBe(false);
    handle.stop();
  });

  it("does not capture hover_dwell unless explicitly enabled (#48, ADR 0003)", () => {
    const { scene, onPointerObservable } = makeScene();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = babylonCollector({ scene, capture: { camera: false, perf: false } }).start(ctx)!;

    onPointerObservable.trigger({
      type: POINTER_MOVE,
      event: {},
      pickInfo: { hit: true, pickedMesh: { name: "Cube" } },
    });
    now.value = 3000;
    onPointerObservable.trigger({ type: POINTER_MOVE, event: {}, pickInfo: { hit: false } });

    expect(events.some((e) => e.type === "hover_dwell")).toBe(false);
    handle.stop();
  });
});

describe("babylonCollector sampling profile (ADR 0012)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("throttles pointer_move at the configured Hz rate", () => {
    const { scene, onPointerObservable } = makeScene();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    // 10 Hz → one sample per 100 ms.
    const handle = babylonCollector({ scene, sampling: { pointerMove: 10 } }).start(ctx)!;

    const move = { type: POINTER_MOVE, event: {}, pickInfo: null };
    onPointerObservable.trigger(move);
    now.value = 1050; // within 100 ms → dropped
    onPointerObservable.trigger(move);
    now.value = 1100; // at the 100 ms boundary → emitted
    onPointerObservable.trigger(move);

    expect(events.filter((e) => e.type === "pointer_move")).toHaveLength(2);
    handle.stop();
  });

  it("captures camera_sample every render tick when set to 'frame'", () => {
    const { scene, onBeforeRenderObservable } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      suppressIdleSamples: false,
      sampling: { camera: "frame" },
      capture: { perf: false },
    }).start(ctx)!;

    // Initial baseline sample, then one per render tick — no timer involved.
    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(1);
    onBeforeRenderObservable.trigger({});
    onBeforeRenderObservable.trigger({});
    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(3);

    handle.stop();
    onBeforeRenderObservable.trigger({});
    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(3); // detached on stop
  });

  it("does not capture a channel whose sampling rate is 0 (off)", () => {
    const { scene } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, sampling: { camera: 0, perf: 0 } }).start(ctx)!;

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "camera_sample")).toBe(false);
    expect(events.some((e) => e.type === "frame_perf")).toBe(false);
    handle.stop();
  });

  it("never throttles discrete clicks regardless of the dial", () => {
    const { scene, onPointerObservable } = makeScene();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = babylonCollector({ scene, sampling: { pointerMove: 1 } }).start(ctx)!;

    const tap = { type: POINTER_TAP, event: { button: 0 }, pickInfo: null };
    onPointerObservable.trigger(tap);
    onPointerObservable.trigger(tap); // same instant — discrete, so still captured
    expect(events.filter((e) => e.type === "pointer_click")).toHaveLength(2);
    handle.stop();
  });

  it("emits context_lost / context_restored from the engine observables", () => {
    const { scene, engine } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

    (engine.onContextLostObservable as FakeObservable<unknown>).trigger({});
    (engine.onContextRestoredObservable as FakeObservable<unknown>).trigger({});

    expect(events.filter((e) => e.type === "context_lost")).toHaveLength(1);
    expect(events.filter((e) => e.type === "context_restored")).toHaveLength(1);

    handle.stop();
    // Detached on stop — no further events.
    (engine.onContextLostObservable as FakeObservable<unknown>).trigger({});
    expect(events.filter((e) => e.type === "context_lost")).toHaveLength(1);
  });

  it("does not subscribe to context loss when the channel is disabled", () => {
    const { scene, engine } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { contextLoss: false } }).start(ctx)!;

    (engine.onContextLostObservable as FakeObservable<unknown>).trigger({});
    expect(events.some((e) => e.type === "context_lost")).toBe(false);
    handle.stop();
  });
});

describe("babylonCollector — scene actors / node_transform (ADR 0027 Tier 1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeNode(over: Record<string, unknown> = {}) {
    return {
      computeWorldMatrix: vi.fn(),
      absolutePosition: { x: 1, y: 2, z: 3 },
      absoluteRotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
      absoluteScaling: { x: 1, y: 1, z: 1 },
      ...over,
    };
  }

  it("emits a node_transform with the world transform for a declared, sampled actor", () => {
    const { scene } = makeScene();
    const node = makeNode();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { door: node },
      sampling: { nodes: { door: 10 } },
    }).start(ctx)!;

    const nt = events.find((e) => e.type === "node_transform");
    expect(nt).toMatchObject({
      type: "node_transform",
      nodeId: "door",
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
    });
    // Identity scale is omitted from the wire.
    expect((nt as Record<string, unknown>).scale).toBeUndefined();
    expect(node.computeWorldMatrix).toHaveBeenCalled();
    handle.stop();
  });

  it("includes scale only when it differs from identity", () => {
    const { scene } = makeScene();
    const node = makeNode({ absoluteScaling: { x: 2, y: 2, z: 2 } });
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { lift: node },
      sampling: { nodes: { lift: 10 } },
    }).start(ctx)!;

    expect(events.find((e) => e.type === "node_transform")).toMatchObject({
      nodeId: "lift",
      scale: [2, 2, 2],
    });
    handle.stop();
  });

  it("does not capture an actor that has no sampling.nodes rate (default OFF)", () => {
    const { scene } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { door: makeNode() },
    }).start(ctx)!;

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
  });

  it("warns and ignores a sampling.nodes id with no matching actor", () => {
    const { scene } = makeScene();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      sampling: { nodes: { ghost: 10 } },
    }).start(ctx)!;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
    warn.mockRestore();
  });

  it("resolves a string actor by mesh name then transform-node name", () => {
    const { scene } = makeScene();
    const node = makeNode();
    (scene as unknown as { getMeshByName: (n: string) => unknown }).getMeshByName = (n) =>
      n === "npc" ? node : null;
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { npc: "npc" },
      sampling: { nodes: { npc: 10 } },
    }).start(ctx)!;

    expect(events.find((e) => e.type === "node_transform")).toMatchObject({ nodeId: "npc" });
    handle.stop();
  });

  it("resolves a function actor lazily and skips ticks while it returns null", () => {
    const { scene, onBeforeRenderObservable } = makeScene();
    let node: ReturnType<typeof makeNode> | null = null;
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { spawned: () => node },
      sampling: { nodes: { spawned: "frame" } },
    }).start(ctx)!;

    // Not yet in the scene → no emit on the initial sample or first ticks.
    onBeforeRenderObservable.trigger({});
    expect(events.some((e) => e.type === "node_transform")).toBe(false);

    node = makeNode();
    onBeforeRenderObservable.trigger({});
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);
    handle.stop();
  });

  it("suppresses idle samples when the transform is unchanged", () => {
    const { scene } = makeScene();
    const node = makeNode();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { door: node },
      sampling: { nodes: { door: 10 } }, // 100 ms interval
    }).start(ctx)!;

    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);
    vi.advanceTimersByTime(300); // 3 ticks, transform unchanged
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);

    node.absolutePosition = { x: 9, y: 9, z: 9 };
    vi.advanceTimersByTime(100);
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(2);
    handle.stop();
  });

  it("captures a subtree with childPath when include is set (ADR 0033)", () => {
    const { scene } = makeScene();
    const hand = makeNode({
      name: "Hand",
      absolutePosition: { x: 4, y: 0, z: 0 },
      getChildren: () => [],
    });
    const body = makeNode({
      name: "Body",
      absolutePosition: { x: 0, y: 5, z: 0 },
      getChildren: () => [hand],
    });
    const rig = makeNode({ name: "rig", getChildren: () => [body] });
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { rig },
      sampling: { nodes: { rig: { hz: 10, include: "*" } } },
    }).start(ctx)!;

    const nts = events.filter((e) => e.type === "node_transform") as Array<Record<string, unknown>>;
    expect(nts).toHaveLength(3); // root + Body + Body/Hand
    expect(nts[0]).toMatchObject({ nodeId: "rig", position: [1, 2, 3] });
    expect(nts[0].childPath).toBeUndefined();
    expect(nts.find((e) => e.childPath === "Body")).toMatchObject({ position: [0, 5, 0] });
    expect(nts.find((e) => e.childPath === "Body/Hand")).toMatchObject({ position: [4, 0, 0] });
    handle.stop();
  });

  it("subtree capture honors maxNodes truncation (ADR 0033)", () => {
    const { scene } = makeScene();
    const children = Array.from({ length: 5 }, (_, i) =>
      makeNode({ name: `c${i}`, absolutePosition: { x: i, y: 0, z: 0 }, getChildren: () => [] }),
    );
    const rig = makeNode({ name: "rig", getChildren: () => children });
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { rig },
      sampling: { nodes: { rig: { hz: 10, include: "*", maxNodes: 2 } } },
    }).start(ctx)!;

    const childNts = (
      events.filter((e) => e.type === "node_transform") as Array<Record<string, unknown>>
    ).filter((e) => e.childPath !== undefined);
    expect(childNts).toHaveLength(2); // capped at maxNodes
    handle.stop();
  });

  it("refuses to capture a node that is a camera (events live once)", () => {
    const { scene } = makeScene();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cam = makeNode({ getClassName: () => "ArcRotateCamera" });
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { cam },
      sampling: { nodes: { cam: 10 } },
    }).start(ctx)!;

    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("camera"));
    handle.stop();
    warn.mockRestore();
  });

  it("detaches node sampling on stop()", () => {
    const { scene, onBeforeRenderObservable } = makeScene();
    const node = makeNode();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      suppressIdleSamples: false,
      capture: { perf: false, camera: false },
      actors: { door: node },
      sampling: { nodes: { door: "frame" } },
    }).start(ctx)!;

    onBeforeRenderObservable.trigger({});
    const before = events.filter((e) => e.type === "node_transform").length;
    handle.stop();
    onBeforeRenderObservable.trigger({});
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(before);
  });
});

describe("babylonCollector — skeleton bones / node_transform (ADR 0027 Tier 2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A column-major Babylon local matrix: translation + uniform scale, identity rotation. */
  function localMatrix(tx: number, ty: number, tz: number, scale = 1): number[] {
    // prettier-ignore
    return [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, tx, ty, tz, 1];
  }

  function makeBone(name: string, m: number[]) {
    return { name, getLocalMatrix: vi.fn(() => ({ m })) };
  }

  /** A skinned node carrying a skeleton with the given bones (Tier-2 source). */
  function makeSkinned(bones: Array<ReturnType<typeof makeBone>>) {
    return { skeleton: { bones } };
  }

  it("emits a Tier-2 node_transform (boneId + skeleton-local pose) for an allowlisted bone", () => {
    const { scene } = makeScene();
    const hand = makeBone("RightHand", localMatrix(1, 2, 3));
    const node = makeSkinned([makeBone("Hips", localMatrix(0, 0, 0)), hand]);
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { guard: node },
      sampling: { bones: { guard: { include: ["RightHand"], hz: 30 } } },
    }).start(ctx)!;

    const nt = events.find((e) => e.type === "node_transform");
    expect(nt).toMatchObject({
      type: "node_transform",
      nodeId: "guard",
      boneId: "RightHand",
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
    });
    // Identity scale stays off the wire; only the allowlisted bone is captured.
    expect((nt as Record<string, unknown>).scale).toBeUndefined();
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);
    expect(hand.getLocalMatrix).toHaveBeenCalled();
    handle.stop();
  });

  it("decodes rotation and scale from the bone's local matrix", () => {
    const { scene } = makeScene();
    // RotZ(180°) (column-major, diagonal) with uniform scale 2 → quat [0,0,1,0], scale [2,2,2].
    // prettier-ignore
    const rotZ180Scaled = [-2, 0, 0, 0, 0, -2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const head = makeBone("Head", rotZ180Scaled);
    const node = makeSkinned([head]);
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { guard: node },
      sampling: { bones: { guard: { include: ["Head"], hz: 30 } } },
    }).start(ctx)!;

    const nt = events.find((e) => e.type === "node_transform") as Record<string, unknown>;
    const rot = nt.rotation as number[];
    expect(rot[0]).toBeCloseTo(0, 5);
    expect(rot[1]).toBeCloseTo(0, 5);
    expect(rot[2]).toBeCloseTo(1, 5);
    expect(rot[3]).toBeCloseTo(0, 5);
    expect(nt.scale as number[]).toEqual([2, 2, 2]);
    handle.stop();
  });

  it('captures every named bone for the explicit "*" wildcard', () => {
    const { scene } = makeScene();
    const node = makeSkinned([
      makeBone("Hips", localMatrix(0, 0, 0)),
      makeBone("Spine", localMatrix(0, 1, 0)),
      makeBone("Head", localMatrix(0, 2, 0)),
    ]);
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { guard: node },
      sampling: { bones: { guard: { include: "*", hz: 30 } } },
    }).start(ctx)!;

    const bones = events
      .filter((e) => e.type === "node_transform")
      .map((e) => (e as Record<string, unknown>).boneId);
    expect(bones).toEqual(["Hips", "Spine", "Head"]);
    handle.stop();
  });

  it("does not capture bones without a sampling.bones entry (default OFF)", () => {
    const { scene } = makeScene();
    const node = makeSkinned([makeBone("Hips", localMatrix(0, 0, 0))]);
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { guard: node },
    }).start(ctx)!;

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
  });

  it("warns and ignores a sampling.bones id with no matching actor", () => {
    const { scene } = makeScene();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      sampling: { bones: { ghost: { include: ["Hips"], hz: 30 } } },
    }).start(ctx)!;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
    warn.mockRestore();
  });

  it("warns once when the resolved actor has no matching skeleton bones", () => {
    const { scene } = makeScene();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const node = makeSkinned([makeBone("Hips", localMatrix(0, 0, 0))]);
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { guard: node },
      sampling: { bones: { guard: { include: ["NoSuchBone"], hz: 30 } } },
    }).start(ctx)!;

    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skeleton bones"));
    handle.stop();
    warn.mockRestore();
  });

  it("suppresses idle bone samples until a bone's local pose changes", () => {
    const { scene } = makeScene();
    let m = localMatrix(0, 0, 0);
    const bone = { name: "Hips", getLocalMatrix: () => ({ m }) };
    const node = { skeleton: { bones: [bone] } };
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false },
      actors: { guard: node },
      sampling: { bones: { guard: { include: ["Hips"], hz: 10 } } }, // 100 ms interval
    }).start(ctx)!;

    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);
    vi.advanceTimersByTime(300); // 3 ticks, pose unchanged
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);

    m = localMatrix(5, 0, 0); // pose moves → next tick emits
    vi.advanceTimersByTime(100);
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(2);
    handle.stop();
  });

  it("respects capture.bones = false even when sampling.bones is configured", () => {
    const { scene } = makeScene();
    const node = makeSkinned([makeBone("Hips", localMatrix(0, 0, 0))]);
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, camera: false, bones: false },
      actors: { guard: node },
      sampling: { bones: { guard: { include: ["Hips"], hz: 30 } } },
    }).start(ctx)!;

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
  });
});

describe("babylonCollector — compile stalls (#42)", () => {
  it("times a shader-compilation span and emits one compile_stall (on by default)", () => {
    const now = { value: 1000 };
    const { scene, engine } = makeScene();
    const { ctx, events } = makeCtx(now);
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

    const before = engine.onBeforeShaderCompilationObservable as FakeObservable<unknown>;
    const after = engine.onAfterShaderCompilationObservable as FakeObservable<unknown>;
    before.trigger({});
    now.value = 1018; // 18ms of main-thread compile
    after.trigger({});

    const stalls = events.filter((e) => e.type === "compile_stall");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ type: "compile_stall", durationMs: 18, phase: "shader" });

    handle.stop();
    // Detached on stop — no further events.
    before.trigger({});
    after.trigger({});
    expect(events.filter((e) => e.type === "compile_stall")).toHaveLength(1);
  });

  it("emits a single stall for nested compilation spans (outermost wins)", () => {
    const now = { value: 1000 };
    const { scene, engine } = makeScene();
    const { ctx, events } = makeCtx(now);
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;

    const before = engine.onBeforeShaderCompilationObservable as FakeObservable<unknown>;
    const after = engine.onAfterShaderCompilationObservable as FakeObservable<unknown>;
    before.trigger({}); // outer start @1000
    now.value = 1005;
    before.trigger({}); // nested start (ignored for timing)
    now.value = 1010;
    after.trigger({}); // nested end (depth still > 0, no emit)
    now.value = 1030;
    after.trigger({}); // outer end -> emit 30ms

    const stalls = events.filter((e) => e.type === "compile_stall");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ durationMs: 30, phase: "shader" });
    handle.stop();
  });

  it("does not subscribe when the channel is disabled", () => {
    const { scene, engine } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { compileStall: false } }).start(ctx)!;

    (engine.onBeforeShaderCompilationObservable as FakeObservable<unknown>).trigger({});
    (engine.onAfterShaderCompilationObservable as FakeObservable<unknown>).trigger({});
    expect(events.some((e) => e.type === "compile_stall")).toBe(false);
    handle.stop();
  });
});

describe("babylonCollector — resource samples (#44)", () => {
  beforeEach(() => vi.useFakeTimers());

  it("does not sample by default (opt-in)", () => {
    const { scene } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({ scene, capture: { perf: false } }).start(ctx)!;
    vi.advanceTimersByTime(60_000);
    expect(events.some((e) => e.type === "resource_sample")).toBe(false);
    handle.stop();
  });

  it("emits a low-rate footprint sample with triangles and vertices when enabled", () => {
    const { scene } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, resourceSample: true },
      resourceSample: { intervalMs: 1000 },
    }).start(ctx)!;

    vi.advanceTimersByTime(1000);
    const samples = events.filter((e) => e.type === "resource_sample");
    expect(samples).toHaveLength(1);
    // 360k active indices / 3 = 120k triangles; vertices passed through.
    expect(samples[0]).toMatchObject({
      type: "resource_sample",
      triangles: 120_000,
      vertices: 90_000,
    });

    handle.stop();
    // Detached on stop — the timer no longer fires.
    vi.advanceTimersByTime(5000);
    expect(events.filter((e) => e.type === "resource_sample")).toHaveLength(1);
  });

  it("omits metrics that aren't measurable (no heap outside Chromium)", () => {
    const { scene } = makeScene();
    const { ctx, events } = makeCtx();
    const handle = babylonCollector({
      scene,
      capture: { perf: false, resourceSample: true },
      resourceSample: { intervalMs: 1000 },
    }).start(ctx)!;

    vi.advanceTimersByTime(1000);
    const sample = events.find((e) => e.type === "resource_sample") as
      | Record<string, unknown>
      | undefined;
    expect(sample).toBeDefined();
    // performance.memory is Chromium-only and absent under the test runtime.
    expect(sample).not.toHaveProperty("jsHeapBytes");
    expect(sample).not.toHaveProperty("textureBytes");
    handle.stop();
  });
});

describe("readDeviceCaps", () => {
  it("maps a WebGL2 engine into a device block", () => {
    const { scene } = makeScene();
    expect(readDeviceCaps(scene)).toMatchObject({
      engine: "webgl2",
      vendor: "Acme",
      renderer: "GPU-9000",
      maxTextureSize: 8192,
    });
  });
});

describe("readSceneMeta", () => {
  it("classifies known Babylon camera class names", () => {
    expect(classifyCamera("ArcRotateCamera")).toBe("arc-rotate");
    expect(classifyCamera("FollowCamera")).toBe("follow");
    expect(classifyCamera("UniversalCamera")).toBe("free");
    expect(classifyCamera("FreeCamera")).toBe("free");
    expect(classifyCamera("SomethingElse")).toBe("other");
    expect(classifyCamera(undefined)).toBe("other");
  });

  it("reads camera kind/name and mesh count from a scene", () => {
    const scene = {
      activeCamera: { name: "mainCamera", getClassName: () => "ArcRotateCamera" },
      meshes: [{}, {}, {}],
    } as unknown as Scene;
    expect(readSceneMeta(scene)).toEqual({
      cameraType: "arc-rotate",
      cameraName: "mainCamera",
      meshCount: 3,
    });
  });
});
