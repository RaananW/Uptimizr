import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBase, Entity } from "playcanvas";
import type { AggregatorConfig, CollectorContext, EventInput, Snapshot } from "@uptimizr/sdk-core";
import { createAggregator } from "@uptimizr/sdk-core";
import { playcanvasCollector } from "../collector.js";
import type { RaycastProbe } from "../raycast.js";

/** A stub device canvas that records DOM listeners and can dispatch events. */
function makeCanvas() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  return {
    listeners,
    addEventListener(type: string, h: (e: unknown) => void) {
      (listeners[type] ??= []).push(h);
    },
    removeEventListener(type: string, h: (e: unknown) => void) {
      listeners[type] = (listeners[type] ?? []).filter((cb) => cb !== h);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    dispatch(type: string, ev: unknown) {
      for (const cb of [...(listeners[type] ?? [])]) cb(ev);
    },
    count(type: string) {
      return (listeners[type] ?? []).length;
    },
  };
}

interface CameraConfig {
  pos?: [number, number, number];
  /** World-space forward (look) direction — PlayCanvas `entity.forward`. */
  forward?: [number, number, number];
  /** World-space up direction — PlayCanvas `entity.up`. */
  up?: [number, number, number];
  projectionFov?: number;
  horizontalFov?: boolean;
  aspectRatio?: number;
}

/**
 * A stub PlayCanvas camera Entity. `getPosition()` and `forward` return world
 * values directly (no sink, no −Z convention — that's the PlayCanvas contract).
 */
function makeCamera(cfg: CameraConfig = {}): Entity {
  const pos = cfg.pos ?? [1, 2, 3];
  const fwd = cfg.forward ?? [0, 0, -1];
  const up = cfg.up ?? [0, 1, 0];
  return {
    getPosition: () => ({ x: pos[0], y: pos[1], z: pos[2] }),
    forward: { x: fwd[0], y: fwd[1], z: fwd[2] },
    up: { x: up[0], y: up[1], z: up[2] },
    camera:
      cfg.projectionFov !== undefined
        ? {
            fov: cfg.projectionFov,
            horizontalFov: cfg.horizontalFov ?? false,
            aspectRatio: cfg.aspectRatio,
          }
        : undefined,
  } as unknown as Entity;
}

/** A stub PlayCanvas app: graphics device + stats + frameend event + root walk. */
function makeApp(
  canvas: ReturnType<typeof makeCanvas>,
  opts: { fps?: number; triangles?: number; nodes?: unknown[] } = {},
) {
  const frameHandlers: Array<(...a: unknown[]) => void> = [];
  const nodes = opts.nodes ?? [];
  const app = {
    graphicsDevice: { canvas },
    stats: { frame: { fps: opts.fps ?? 0, triangles: opts.triangles ?? 0 } },
    root: {
      forEach(cb: (n: unknown) => void) {
        for (const n of nodes) cb(n);
      },
    },
    on(name: string, cb: (...a: unknown[]) => void) {
      if (name === "frameend") frameHandlers.push(cb);
    },
    off(name: string, cb: (...a: unknown[]) => void) {
      if (name === "frameend") {
        const i = frameHandlers.indexOf(cb);
        if (i >= 0) frameHandlers.splice(i, 1);
      }
    },
    /** Test helper: fire one engine `frameend` tick. */
    frame() {
      for (const cb of [...frameHandlers]) cb();
    },
    /** Test helper: number of bound frameend handlers. */
    frameendCount() {
      return frameHandlers.length;
    },
  };
  return app as unknown as AppBase & {
    stats: { frame: { fps: number; triangles: number } };
    frame(): void;
    frameendCount(): number;
  };
}

/** A stub PlayCanvas renderable entity with a single world-AABB mesh instance. */
function makeMesh(
  name: string,
  min: [number, number, number],
  max: [number, number, number],
  opts: { visible?: boolean; enabled?: boolean } = {},
) {
  return {
    name,
    enabled: opts.enabled ?? true,
    render: {
      meshInstances: [
        {
          visible: opts.visible ?? true,
          aabb: {
            getMin: () => ({ x: min[0], y: min[1], z: min[2] }),
            getMax: () => ({ x: max[0], y: max[1], z: max[2] }),
          },
        },
      ],
    },
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

describe("playcanvasCollector", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("normalizes a right-handed camera pose to the canonical frame (ADR 0018)", () => {
    // PlayCanvas world position (1,2,3) → canonical negates Z → (1,2,-3).
    // PlayCanvas world forward (0,0,-1) → canonical negates Z → (0,0,1).
    const camera = makeCamera({ pos: [1, 2, 3], forward: [0, 0, -1] });
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(makeCanvas()),
      camera,
      capture: { perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    expect(events.find((e) => e.type === "camera_sample")).toMatchObject({
      type: "camera_sample",
      position: [1, 2, -3],
      direction: [0, 0, 1],
    });
    handle.stop();
  });

  it("converts a perspective camera's FOV from degrees to radians", () => {
    const camera = makeCamera({ projectionFov: 90 });
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(makeCanvas()),
      camera,
      capture: { perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample") as { fov?: number };
    expect(cam.fov).toBeCloseTo(Math.PI / 2, 6);
    handle.stop();
  });

  it("converts a horizontal FOV to vertical using the aspect ratio", () => {
    // hfov 90° at aspect 2 → vfov = 2*atan(tan(45°)/2) ≈ 0.9273 rad.
    const camera = makeCamera({ projectionFov: 90, horizontalFov: true, aspectRatio: 2 });
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(makeCanvas()),
      camera,
      capture: { perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample") as { fov?: number };
    expect(cam.fov).toBeCloseTo(2 * Math.atan(Math.tan(Math.PI / 4) / 2), 6);
    handle.stop();
  });

  it("attaches a gaze hit-point to camera_sample when gaze capture is enabled (ADR 0030)", () => {
    const camera = makeCamera();
    const { ctx, events } = makeCtx();
    const probe = vi.fn(() => ({ point: [4, 5, 6] as [number, number, number], name: "Wall" }));
    const handle = playcanvasCollector({
      app: makeApp(makeCanvas()),
      camera,
      capture: { perf: false, gaze: true },
      gaze: { probe },
    }).start(ctx)!;

    // PlayCanvas is right-handed → the hit point's Z is negated to the canonical frame.
    expect(events.find((e) => e.type === "camera_sample")).toMatchObject({
      type: "camera_sample",
      hitPoint: [4, 5, -6],
      hitMesh: "Wall",
    });
    expect(probe).toHaveBeenCalled();
    handle.stop();
  });

  it("omits gaze fields and never probes when gaze capture is disabled", () => {
    const camera = makeCamera();
    const { ctx, events } = makeCtx();
    const probe = vi.fn(() => ({ point: [4, 5, 6] as [number, number, number], name: "Wall" }));
    const handle = playcanvasCollector({
      app: makeApp(makeCanvas()),
      camera,
      capture: { perf: false },
      gaze: { probe },
    }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample");
    expect(cam).not.toHaveProperty("hitPoint");
    expect(cam).not.toHaveProperty("hitMesh");
    expect(probe).not.toHaveBeenCalled();
    handle.stop();
  });

  it("leaves gaze fields unset on a ray miss", () => {
    const camera = makeCamera();
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(makeCanvas()),
      camera,
      capture: { perf: false, gaze: true },
      gaze: { probe: () => undefined },
    }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample");
    expect(cam).not.toHaveProperty("hitPoint");
    expect(cam).not.toHaveProperty("hitMesh");
    handle.stop();
  });

  it("reads frame_perf from app.stats.frame.fps and stops cleanly", () => {
    const canvas = makeCanvas();
    const app = makeApp(canvas, { fps: 60 });
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app,
      camera: makeCamera(),
      samplePerfMs: 1000,
      capture: { camera: false },
      raycast: () => undefined,
    }).start(ctx)!;

    vi.advanceTimersByTime(1000);
    expect(events.find((e) => e.type === "frame_perf")).toMatchObject({
      type: "frame_perf",
      fps: 60,
    });

    handle.stop();
    const before = events.length;
    app.stats.frame.fps = 120;
    vi.advanceTimersByTime(2000);
    canvas.dispatch("click", { clientX: 1, clientY: 1, button: 0 });
    expect(events.length).toBe(before); // no events after stop
  });

  it("removes every DOM listener, timer, and frameend handler on stop", () => {
    const canvas = makeCanvas();
    const app = makeApp(canvas);
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app,
      camera: makeCamera(),
      sampling: { camera: "frame" },
      raycast: () => undefined,
    }).start(ctx)!;

    expect(canvas.count("pointermove")).toBe(1);
    // Two pointerdown/up listeners: one for buttons, one for camera_gesture (ADR 0025).
    expect(canvas.count("pointerdown")).toBe(2);
    expect(canvas.count("pointerup")).toBe(2);
    expect(canvas.count("click")).toBe(1);
    expect(canvas.count("webglcontextlost")).toBe(1);
    expect(app.frameendCount()).toBe(1);

    handle.stop();
    for (const type of [
      "pointermove",
      "pointerdown",
      "pointerup",
      "click",
      "webglcontextlost",
      "webglcontextrestored",
    ]) {
      expect(canvas.count(type)).toBe(0);
    }
    expect(app.frameendCount()).toBe(0);

    const before = events.length;
    canvas.dispatch("pointermove", { clientX: 1, clientY: 1 });
    app.frame();
    vi.advanceTimersByTime(5000);
    expect(events.length).toBe(before);
  });

  it("normalizes pointer screen coords and a raycast hit (click → pointer_click + mesh_interaction)", () => {
    const canvas = makeCanvas();
    // Hit point is in PlayCanvas' right-handed frame; the collector negates Z.
    const raycast: RaycastProbe = () => ({ point: [4, 5, -6], name: "Cube" });
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      raycast,
    }).start(ctx)!;

    canvas.dispatch("click", { clientX: 400, clientY: 300, button: 0, pointerType: "mouse" });

    expect(events.find((e) => e.type === "pointer_click")).toMatchObject({
      type: "pointer_click",
      screen: [0.5, 0.5],
      button: 0,
      hitMesh: "Cube",
      hitPoint: [4, 5, 6],
      source: "mouse",
    });
    expect(events.find((e) => e.type === "mesh_interaction")).toMatchObject({
      type: "mesh_interaction",
      mesh: "Cube",
      kind: "pick",
      point: [4, 5, 6],
      source: "mouse",
    });
    handle.stop();
  });

  it("reports the crosshair (centre) and re-picks at NDC (0,0) while pointer-locked (ADR 0034)", () => {
    const canvas = makeCanvas();
    const ndc: Array<[number, number]> = [];
    const raycast: RaycastProbe = (x, y) => {
      ndc.push([x, y]);
      return { point: [1, 1, -1], name: "Exhibit" };
    };
    const { ctx, events } = makeCtx();

    const prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { pointerLockElement: canvas };
    try {
      const handle = playcanvasCollector({
        app: makeApp(canvas),
        camera: makeCamera(),
        capture: { camera: false, perf: false },
        raycast,
      }).start(ctx)!;

      // A click far from centre: unlocked this would be screen ~[0.875, 0.167].
      canvas.dispatch("click", { clientX: 700, clientY: 100, button: 0, pointerType: "mouse" });

      expect(events.find((e) => e.type === "pointer_click")).toMatchObject({
        type: "pointer_click",
        screen: [0.5, 0.5],
        hitMesh: "Exhibit",
      });
      expect(ndc).toContainEqual([0, 0]);
      handle.stop();
    } finally {
      if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = prevDoc;
    }
  });

  it("emits throttled pointer_move with normalized screen and hit", () => {
    const canvas = makeCanvas();
    const raycast: RaycastProbe = () => ({ point: [0, 0, 0], name: "Floor" });
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera: makeCamera(),
      pointerMoveThrottleMs: 250,
      capture: { camera: false, perf: false },
      raycast,
    }).start(ctx)!;

    const move = { clientX: 400, clientY: 300, pointerType: "mouse" };
    canvas.dispatch("pointermove", move);
    canvas.dispatch("pointermove", move); // within throttle window → dropped
    now.value = 1300;
    canvas.dispatch("pointermove", move); // after window → emitted

    const moves = events.filter((e) => e.type === "pointer_move");
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({ screen: [0.5, 0.5], hitMesh: "Floor" });
    handle.stop();
  });

  it("emits pointer_down and pointer_up with the button", () => {
    const canvas = makeCanvas();
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    canvas.dispatch("pointerdown", { clientX: 400, clientY: 300, button: 2 });
    canvas.dispatch("pointerup", { clientX: 400, clientY: 300, button: 2 });

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

  it("emits a camera_gesture when the view turns between pointer down and up (ADR 0025)", () => {
    const canvas = makeCanvas();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    // A camera whose forward can be mutated between down and up.
    const camera = {
      getPosition: () => ({ x: 0, y: 0, z: 10 }),
      forward: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      camera: { fov: 60, horizontalFov: false },
    } as unknown as Entity;
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera,
      capture: {
        camera: false,
        perf: false,
        pointerMove: false,
        clicks: false,
        buttons: false,
        meshPicks: false,
      },
      raycast: () => undefined,
    }).start(ctx)!;

    canvas.dispatch("pointerdown", { clientX: 400, clientY: 300, button: 0, pointerType: "mouse" });
    // Turn the forward ~45°.
    (camera as unknown as { forward: { x: number; y: number; z: number } }).forward = {
      x: Math.SQRT1_2,
      y: 0,
      z: -Math.SQRT1_2,
    };
    now.value = 1500;
    canvas.dispatch("pointerup", { clientX: 500, clientY: 300, button: 0, pointerType: "mouse" });

    const gesture = events.find((e) => e.type === "camera_gesture");
    expect(gesture).toMatchObject({
      type: "camera_gesture",
      kind: "orbit",
      durationMs: 500,
      source: "mouse",
    });
    expect((gesture as { orbitDeg: number }).orbitDeg).toBeGreaterThan(40);
    handle.stop();
  });

  it("does not emit a camera_gesture when the camera holds still", () => {
    const canvas = makeCanvas();
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera: makeCamera(),
      capture: {
        camera: false,
        perf: false,
        pointerMove: false,
        clicks: false,
        buttons: false,
        meshPicks: false,
      },
      raycast: () => undefined,
    }).start(ctx)!;

    canvas.dispatch("pointerdown", { clientX: 400, clientY: 300, button: 0 });
    canvas.dispatch("pointerup", { clientX: 400, clientY: 300, button: 0 });

    expect(events.some((e) => e.type === "camera_gesture")).toBe(false);
    handle.stop();
  });

  it("maps the DOM pointerType to an input source (ADR 0011)", () => {
    const canvas = makeCanvas();
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    canvas.dispatch("click", { clientX: 0, clientY: 0, button: 0, pointerType: "touch" });
    canvas.dispatch("click", { clientX: 0, clientY: 0, button: 0, pointerType: "pen" });
    canvas.dispatch("click", { clientX: 0, clientY: 0, button: 0, pointerType: "wand" });
    canvas.dispatch("click", { clientX: 0, clientY: 0, button: 0 });

    const clicks = events.filter((e) => e.type === "pointer_click");
    expect(clicks[0]).toMatchObject({ source: "touch" });
    expect(clicks[1]).toMatchObject({ source: "pen" });
    expect(clicks[2]).toMatchObject({ source: "other" });
    expect(clicks[3]).not.toHaveProperty("source");
    handle.stop();
  });

  it("emits an initial camera_sample and suppresses idle samples by default", () => {
    const camera = makeCamera({ pos: [0, 0, 0] });
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(makeCanvas()),
      camera,
      sampleCameraMs: 1000,
      capture: { perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(1);
    handle.stop();
  });

  it("does not capture a channel whose sampling rate is 0 (off)", () => {
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(makeCanvas(), { fps: 60 }),
      camera: makeCamera(),
      sampling: { camera: 0, perf: 0 },
      raycast: () => undefined,
    }).start(ctx)!;

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "camera_sample")).toBe(false);
    expect(events.some((e) => e.type === "frame_perf")).toBe(false);
    handle.stop();
  });

  it("emits context_lost / context_restored from canvas WebGL events", () => {
    const canvas = makeCanvas();
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    canvas.dispatch("webglcontextlost", {});
    canvas.dispatch("webglcontextrestored", {});
    expect(events.filter((e) => e.type === "context_lost")).toHaveLength(1);
    expect(events.filter((e) => e.type === "context_restored")).toHaveLength(1);
    handle.stop();
  });

  // --- resource_sample (#44) — GPU/memory footprint, opt-in ---

  it("does not sample resource footprint by default (opt-in)", () => {
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(makeCanvas(), { triangles: 120_000 }),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    vi.advanceTimersByTime(60_000);
    expect(events.some((e) => e.type === "resource_sample")).toBe(false);
    handle.stop();
  });

  it("emits a low-rate footprint sample with triangles from app.stats.frame when enabled (#44)", () => {
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeApp(makeCanvas(), { triangles: 120_000 }),
      camera: makeCamera(),
      capture: { camera: false, perf: false, resourceSample: true },
      resourceSample: { intervalMs: 1000 },
      raycast: () => undefined,
    }).start(ctx)!;

    vi.advanceTimersByTime(1000);
    const samples = events.filter((e) => e.type === "resource_sample");
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ type: "resource_sample", triangles: 120_000 });
    // PlayCanvas exposes no per-frame vertex count — that metric is omitted, not zeroed.
    expect(samples[0]).not.toHaveProperty("vertices");

    handle.stop();
    vi.advanceTimersByTime(5000);
    expect(events.filter((e) => e.type === "resource_sample")).toHaveLength(1);
  });

  it("drives a 'frame'-cadence channel with the engine frameend event", () => {
    const app = makeApp(makeCanvas());
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app,
      camera: makeCamera(),
      suppressIdleSamples: false,
      sampling: { camera: "frame" },
      capture: { perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    // Initial baseline sample, then one per engine frame — no timer involved.
    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(1);
    app.frame();
    app.frame();
    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(3);

    handle.stop();
    app.frame(); // detached on stop → no further samples
    expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(3);
  });

  // --- mesh_visibility (#37) — per-object dwell, opt-in ---

  it("emits one bucketed mesh_visibility summary per visible object per window (#37)", () => {
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    // Camera at (1,2,3) looking down −Z. One mesh ahead, one behind.
    const app = makeApp(makeCanvas(), {
      nodes: [
        makeMesh("product-hero", [0.5, 1.5, -15], [1.5, 2.5, -13]),
        makeMesh("backdrop", [0, 0, 13], [1, 1, 15]),
      ],
    });
    const handle = playcanvasCollector({
      app,
      camera: makeCamera({ pos: [1, 2, 3], forward: [0, 0, -1] }),
      capture: { camera: false, perf: false, meshVisibility: true },
      meshVisibility: { windowMs: 1000 },
      raycast: () => undefined,
    }).start(ctx)!;

    // 10 engine frames, 100ms apart → 1000ms on-screen for the front mesh.
    for (let i = 0; i < 10; i++) {
      now.value += 100;
      app.frame();
    }
    vi.advanceTimersByTime(1000); // window flush

    const vis = events.filter((e) => e.type === "mesh_visibility");
    // Only the mesh in front of the camera is visible (half-space test).
    expect(vis).toHaveLength(1);
    expect(vis[0]).toMatchObject({ type: "mesh_visibility", mesh: "product-hero" });
    expect((vis[0] as unknown as { visibleMs: number }).visibleMs).toBe(1000);
    expect((vis[0] as unknown as { centeredMs: number }).centeredMs).toBe(1000);
    handle.stop();
  });

  it("rides the world AABB along once per object when boundingBox is on (#53)", () => {
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const app = makeApp(makeCanvas(), {
      nodes: [makeMesh("product-hero", [0.5, 1.5, -15], [1.5, 2.5, -13])],
    });
    const handle = playcanvasCollector({
      app,
      camera: makeCamera({ pos: [1, 2, 3], forward: [0, 0, -1] }),
      capture: { camera: false, perf: false, meshVisibility: true },
      meshVisibility: { windowMs: 1000, boundingBox: true },
      raycast: () => undefined,
    }).start(ctx)!;

    // First window: bounds ride along (canonical frame negates Z).
    for (let i = 0; i < 5; i++) {
      now.value += 100;
      app.frame();
    }
    vi.advanceTimersByTime(1000);
    // Second window: bounds unchanged, so they are NOT re-sent.
    for (let i = 0; i < 5; i++) {
      now.value += 100;
      app.frame();
    }
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
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const app = makeApp(makeCanvas(), {
      nodes: [makeMesh("product-hero", [0.5, 1.5, -15], [1.5, 2.5, -13])],
    });
    const handle = playcanvasCollector({
      app,
      camera: makeCamera({ pos: [1, 2, 3], forward: [0, 0, -1] }),
      capture: { camera: false, perf: false, meshVisibility: true },
      meshVisibility: { windowMs: 1000 },
      raycast: () => undefined,
    }).start(ctx)!;

    for (let i = 0; i < 5; i++) {
      now.value += 100;
      app.frame();
    }
    vi.advanceTimersByTime(1000);

    const vis = events.filter((e) => e.type === "mesh_visibility") as unknown as {
      bounds?: number[];
    }[];
    expect(vis).toHaveLength(1);
    expect(vis[0]!.bounds).toBeUndefined();
    handle.stop();
  });

  it("does not capture mesh_visibility unless explicitly enabled (#37, ADR 0003)", () => {
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const app = makeApp(makeCanvas(), {
      nodes: [makeMesh("product-hero", [0.5, 1.5, -15], [1.5, 2.5, -13])],
    });
    const handle = playcanvasCollector({
      app,
      camera: makeCamera({ pos: [1, 2, 3], forward: [0, 0, -1] }),
      capture: { camera: false, perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    for (let i = 0; i < 5; i++) {
      now.value += 100;
      app.frame();
    }
    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "mesh_visibility")).toBe(false);
    handle.stop();
  });

  // --- hover_dwell (#48) — hover hesitation, opt-in ---

  it("emits a hover_dwell summary when the pointer lingers on an object then leaves (#48)", () => {
    const canvas = makeCanvas();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    let hitName: string | undefined = "Cube";
    const raycast: RaycastProbe = () => (hitName ? { point: [0, 0, 0], name: hitName } : undefined);
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera: makeCamera(),
      capture: { camera: false, perf: false, hoverDwell: true },
      hoverDwell: { minDwellMs: 500 },
      raycast,
    }).start(ctx)!;

    // Hover onto "Cube" at T0, linger, then move onto "Sphere" at T0+800ms.
    canvas.dispatch("pointermove", { clientX: 400, clientY: 300, pointerType: "mouse" });
    now.value = 1800;
    hitName = "Sphere";
    canvas.dispatch("pointermove", { clientX: 400, clientY: 300, pointerType: "mouse" });

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
    const canvas = makeCanvas();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    let hitName: string | undefined = "Cube";
    const raycast: RaycastProbe = () => (hitName ? { point: [0, 0, 0], name: hitName } : undefined);
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera: makeCamera(),
      capture: { camera: false, perf: false, hoverDwell: true },
      hoverDwell: { minDwellMs: 500 },
      raycast,
    }).start(ctx)!;

    canvas.dispatch("pointermove", { clientX: 400, clientY: 300 });
    now.value = 1800;
    // A click on the hovered object marks it as an action, not hesitation.
    canvas.dispatch("click", { clientX: 400, clientY: 300, button: 0 });
    now.value = 2000;
    hitName = undefined;
    canvas.dispatch("pointermove", { clientX: 400, clientY: 300 });

    expect(events.some((e) => e.type === "hover_dwell")).toBe(false);
    handle.stop();
  });

  it("drops hover episodes shorter than minDwellMs (#48)", () => {
    const canvas = makeCanvas();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    let hitName: string | undefined = "Cube";
    const raycast: RaycastProbe = () => (hitName ? { point: [0, 0, 0], name: hitName } : undefined);
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera: makeCamera(),
      capture: { camera: false, perf: false, hoverDwell: true },
      hoverDwell: { minDwellMs: 500 },
      raycast,
    }).start(ctx)!;

    canvas.dispatch("pointermove", { clientX: 400, clientY: 300 });
    now.value = 1200; // only 200ms < 500ms threshold
    hitName = "Sphere";
    canvas.dispatch("pointermove", { clientX: 400, clientY: 300 });

    expect(events.some((e) => e.type === "hover_dwell")).toBe(false);
    handle.stop();
  });

  it("does not capture hover_dwell unless explicitly enabled (#48, ADR 0003)", () => {
    const canvas = makeCanvas();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    let hitName: string | undefined = "Cube";
    const raycast: RaycastProbe = () => (hitName ? { point: [0, 0, 0], name: hitName } : undefined);
    const handle = playcanvasCollector({
      app: makeApp(canvas),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      raycast,
    }).start(ctx)!;

    canvas.dispatch("pointermove", { clientX: 400, clientY: 300 });
    now.value = 1800;
    hitName = "Sphere";
    canvas.dispatch("pointermove", { clientX: 400, clientY: 300 });

    expect(events.some((e) => e.type === "hover_dwell")).toBe(false);
    handle.stop();
  });
});

describe("playcanvasCollector — scene actors / node_transform (ADR 0027 Tier 1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A stub PlayCanvas actor Entity with world-space position/rotation/scale readers. */
  function makeActor(
    pos: [number, number, number] = [1, 2, 3],
    rot: [number, number, number, number] = [0, 0, 0, 1],
    scale: [number, number, number] = [1, 1, 1],
    over: Record<string, unknown> = {},
  ) {
    return {
      getPosition: () => ({ x: pos[0], y: pos[1], z: pos[2] }),
      getRotation: () => ({ x: rot[0], y: rot[1], z: rot[2], w: rot[3] }),
      getWorldTransform: () => ({ getScale: () => ({ x: scale[0], y: scale[1], z: scale[2] }) }),
      ...over,
    };
  }

  /** A stub app whose root resolves named actors via `findByName`. */
  function makeActorApp(named: Record<string, unknown> = {}) {
    return {
      graphicsDevice: { canvas: makeCanvas() },
      stats: { frame: { fps: 0, triangles: 0 } },
      root: { findByName: (n: string) => named[n] ?? null, forEach: () => {} },
      on: () => {},
      off: () => {},
    } as unknown as AppBase;
  }

  it("emits a node_transform with the canonical world transform (Z negated)", () => {
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { lift: makeActor([1, 2, 3]) as unknown as Entity },
      sampling: { nodes: { lift: 10 } },
    }).start(ctx)!;

    const nt = events.find((e) => e.type === "node_transform");
    expect(nt).toMatchObject({
      type: "node_transform",
      nodeId: "lift",
      position: [1, 2, -3],
      rotation: [0, 0, 0, 1],
    });
    expect((nt as Record<string, unknown>).scale).toBeUndefined();
    handle.stop();
  });

  it("reflects the quaternion across the handedness boundary (−x, −y, z, w)", () => {
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { npc: makeActor([0, 0, 0], [0.1, 0.2, 0.3, 0.4]) as unknown as Entity },
      sampling: { nodes: { npc: 10 } },
    }).start(ctx)!;

    expect(events.find((e) => e.type === "node_transform")).toMatchObject({
      rotation: [-0.1, -0.2, 0.3, 0.4],
    });
    handle.stop();
  });

  it("includes non-identity scale (invariant under the reflection)", () => {
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { lift: makeActor([0, 0, 0], [0, 0, 0, 1], [2, 3, 4]) as unknown as Entity },
      sampling: { nodes: { lift: 10 } },
    }).start(ctx)!;

    expect(events.find((e) => e.type === "node_transform")).toMatchObject({
      scale: [2, 3, 4],
    });
    handle.stop();
  });

  it("does not capture an actor without a sampling.nodes rate (default OFF)", () => {
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { lift: makeActor() as unknown as Entity },
    }).start(ctx)!;

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
  });

  it("warns and ignores a sampling.nodes id with no matching actor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      sampling: { nodes: { ghost: 10 } },
    }).start(ctx)!;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
    warn.mockRestore();
  });

  it("resolves a string actor via app.root.findByName", () => {
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp({ Patrol: makeActor([5, 0, 7]) }),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { guard: "Patrol" },
      sampling: { nodes: { guard: 10 } },
    }).start(ctx)!;

    expect(events.find((e) => e.type === "node_transform")).toMatchObject({
      nodeId: "guard",
      position: [5, 0, -7],
    });
    handle.stop();
  });

  it("refuses to capture a node that is a camera (events live once)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cam = makeActor([0, 0, 0], [0, 0, 0, 1], [1, 1, 1], { camera: {} });
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { cam: cam as unknown as Entity },
      sampling: { nodes: { cam: 10 } },
    }).start(ctx)!;

    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("camera"));
    handle.stop();
    warn.mockRestore();
  });

  it("suppresses idle samples when the transform is unchanged", () => {
    let z = 3;
    const actor = {
      getPosition: () => ({ x: 1, y: 2, z }),
      getRotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
      getWorldTransform: () => ({ getScale: () => ({ x: 1, y: 1, z: 1 }) }),
    };
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { lift: actor as unknown as Entity },
      sampling: { nodes: { lift: 10 } }, // 100 ms interval
    }).start(ctx)!;

    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);

    z = 9;
    vi.advanceTimersByTime(100);
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(2);
    handle.stop();
  });
});

describe("playcanvasCollector — skeleton bones / node_transform (ADR 0027 Tier 2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A stub PlayCanvas bone GraphNode exposing its parent-relative local TRS. */
  function makeBone(
    name: string,
    p: [number, number, number] = [0, 0, 0],
    q: [number, number, number, number] = [0, 0, 0, 1],
    s: [number, number, number] = [1, 1, 1],
  ) {
    return {
      name,
      getLocalPosition: () => ({ x: p[0], y: p[1], z: p[2] }),
      getLocalRotation: () => ({ x: q[0], y: q[1], z: q[2], w: q[3] }),
      getLocalScale: () => ({ x: s[0], y: s[1], z: s[2] }),
    };
  }

  /** A skinned actor Entity whose render mesh instances share one bone set. */
  function makeSkinned(bones: Array<ReturnType<typeof makeBone>>) {
    return { render: { meshInstances: [{ skinInstance: { bones } }] } };
  }

  /** A stub app whose root resolves named actors via `findByName`. */
  function makeActorApp(named: Record<string, unknown> = {}) {
    return {
      graphicsDevice: { canvas: makeCanvas() },
      stats: { frame: { fps: 0, triangles: 0 } },
      root: { findByName: (n: string) => named[n] ?? null, forEach: () => {} },
      on: () => {},
      off: () => {},
    } as unknown as AppBase;
  }

  it("emits a Tier-2 node_transform (boneId + canonical local pose) for an allowlisted bone", () => {
    const hand = makeBone("RightHand", [1, 2, 3]);
    const node = makeSkinned([makeBone("Hips"), hand]);
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { guard: node as unknown as Entity },
      sampling: { bones: { guard: { include: ["RightHand"], hz: 30 } } },
    }).start(ctx)!;

    const nt = events.find((e) => e.type === "node_transform");
    expect(nt).toMatchObject({
      type: "node_transform",
      nodeId: "guard",
      boneId: "RightHand",
      position: [1, 2, -3],
      rotation: [0, 0, 0, 1],
    });
    expect((nt as Record<string, unknown>).scale).toBeUndefined();
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);
    handle.stop();
  });

  it("reflects rotation into the canonical frame and includes non-identity scale", () => {
    const head = makeBone("Head", [0, 0, 0], [0.1, 0.2, 0.3, 0.4], [2, 2, 2]);
    const node = makeSkinned([head]);
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { guard: node as unknown as Entity },
      sampling: { bones: { guard: { include: ["Head"], hz: 30 } } },
    }).start(ctx)!;

    expect(events.find((e) => e.type === "node_transform")).toMatchObject({
      boneId: "Head",
      rotation: [-0.1, -0.2, 0.3, 0.4],
      scale: [2, 2, 2],
    });
    handle.stop();
  });

  it('captures every named bone (deduped) for the explicit "*" wildcard', () => {
    const node = makeSkinned([
      makeBone("Hips", [0, 0, 0]),
      makeBone("Spine", [0, 1, 0]),
      makeBone("Head", [0, 2, 0]),
    ]);
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { guard: node as unknown as Entity },
      sampling: { bones: { guard: { include: "*", hz: 30 } } },
    }).start(ctx)!;

    const bones = events
      .filter((e) => e.type === "node_transform")
      .map((e) => (e as Record<string, unknown>).boneId);
    expect(bones).toEqual(["Hips", "Spine", "Head"]);
    handle.stop();
  });

  it("does not capture bones without a sampling.bones entry (default OFF)", () => {
    const node = makeSkinned([makeBone("Hips")]);
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { guard: node as unknown as Entity },
    }).start(ctx)!;

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
  });

  it("warns and ignores a sampling.bones id with no matching actor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      sampling: { bones: { ghost: { include: ["Hips"], hz: 30 } } },
    }).start(ctx)!;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
    warn.mockRestore();
  });

  it("warns once when the resolved actor has no matching skeleton bones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const node = makeSkinned([makeBone("Hips")]);
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { guard: node as unknown as Entity },
      sampling: { bones: { guard: { include: ["NoSuchBone"], hz: 30 } } },
    }).start(ctx)!;

    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skeleton bones"));
    handle.stop();
    warn.mockRestore();
  });

  it("suppresses idle bone samples until a bone's local pose changes", () => {
    let x = 0;
    const bone = {
      name: "Hips",
      getLocalPosition: () => ({ x, y: 0, z: 0 }),
      getLocalRotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
      getLocalScale: () => ({ x: 1, y: 1, z: 1 }),
    };
    const node = { render: { meshInstances: [{ skinInstance: { bones: [bone] } }] } };
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false },
      actors: { guard: node as unknown as Entity },
      sampling: { bones: { guard: { include: ["Hips"], hz: 10 } } }, // 100 ms interval
    }).start(ctx)!;

    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);
    vi.advanceTimersByTime(300); // pose unchanged
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);

    x = 5; // pose moves → next tick emits
    vi.advanceTimersByTime(100);
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(2);
    handle.stop();
  });

  it("respects capture.bones = false even when sampling.bones is configured", () => {
    const node = makeSkinned([makeBone("Hips")]);
    const { ctx, events } = makeCtx();
    const handle = playcanvasCollector({
      app: makeActorApp(),
      camera: makeCamera(),
      capture: { camera: false, perf: false, bones: false },
      actors: { guard: node as unknown as Entity },
      sampling: { bones: { guard: { include: ["Hips"], hz: 30 } } },
    }).start(ctx)!;

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
  });

  it("captures only allowlisted keys as input_action, mapping code to the bound action (ADR 0023)", () => {
    // Stub a window with a listener registry — the connector binds keyboard on
    // `window` (the canvas rarely holds focus in pointer-lock / FPS scenes).
    const keyListeners: Record<string, Array<(e: unknown) => void>> = {};
    const win = {
      addEventListener: (type: string, h: (e: unknown) => void) => {
        (keyListeners[type] ??= []).push(h);
      },
      removeEventListener: (type: string, h: (e: unknown) => void) => {
        keyListeners[type] = (keyListeners[type] ?? []).filter((cb) => cb !== h);
      },
      dispatch: (type: string, ev: unknown) => {
        for (const cb of [...(keyListeners[type] ?? [])]) cb(ev);
      },
    };
    const prevWin = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = win;
    try {
      const { ctx, events } = makeCtx();
      const handle = playcanvasCollector({
        app: makeApp(makeCanvas()),
        camera: makeCamera(),
        capture: { camera: false, perf: false },
        keyBindings: { KeyN: "next-camera" },
        raycast: () => undefined,
      }).start(ctx)!;

      win.dispatch("keydown", { code: "KeyN", repeat: false });
      win.dispatch("keyup", { code: "KeyN", repeat: false });
      win.dispatch("keydown", { code: "KeyN", repeat: true }); // auto-repeat → dropped
      win.dispatch("keydown", { code: "KeyZ", repeat: false }); // unbound → ignored

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
      expect((keyListeners.keydown ?? []).length).toBe(0);
      expect((keyListeners.keyup ?? []).length).toBe(0);
    } finally {
      if (prevWin === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prevWin;
    }
  });

  it("captures no keyboard input when no keyBindings are provided", () => {
    const keyListeners: Record<string, Array<(e: unknown) => void>> = {};
    const win = {
      addEventListener: (type: string, h: (e: unknown) => void) => {
        (keyListeners[type] ??= []).push(h);
      },
      removeEventListener: () => {},
      dispatch: (type: string, ev: unknown) => {
        for (const cb of [...(keyListeners[type] ?? [])]) cb(ev);
      },
    };
    const prevWin = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = win;
    try {
      const { ctx, events } = makeCtx();
      const handle = playcanvasCollector({
        app: makeApp(makeCanvas()),
        camera: makeCamera(),
        capture: { camera: false, perf: false },
        raycast: () => undefined,
      }).start(ctx)!;

      expect((keyListeners.keydown ?? []).length).toBe(0);
      win.dispatch("keydown", { code: "KeyN", repeat: false });
      expect(events.some((e) => e.type === "input_action")).toBe(false);
      handle.stop();
    } finally {
      if (prevWin === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prevWin;
    }
  });
});
