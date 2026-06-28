import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Camera, Scene, WebGLRenderer } from "three";
import type { AggregatorConfig, CollectorContext, EventInput, Snapshot } from "@uptimizr/sdk-core";
import { createAggregator } from "@uptimizr/sdk-core";
import { threeCollector } from "../collector.js";
import type { RaycastProbe } from "../raycast.js";

/** A stub renderer canvas that records DOM listeners and can dispatch events. */
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
  dir?: [number, number, number];
  isPerspectiveCamera?: boolean;
  fov?: number;
}

/** A stub three camera whose world readers write into the collector's sink. */
function makeCamera(cfg: CameraConfig = {}) {
  const pos = cfg.pos ?? [1, 2, 3];
  const dir = cfg.dir ?? [0, 0, -1];
  return {
    isPerspectiveCamera: cfg.isPerspectiveCamera ?? false,
    fov: cfg.fov,
    getWorldPosition(t: { set(x: number, y: number, z: number): unknown }) {
      t.set(pos[0], pos[1], pos[2]);
      return t;
    },
    getWorldDirection(t: {
      set(x: number, y: number, z: number): typeof t;
      normalize(): typeof t;
      negate(): typeof t;
    }) {
      // Mirror three's `Camera.getWorldDirection`: it writes the +Z column then
      // `.negate()`s (cameras look down −Z). Exercising the real call chain guards
      // against the sink missing `negate`/`normalize` (which silently aborts the
      // connector at runtime).
      t.set(-dir[0], -dir[1], -dir[2]).normalize().negate();
      return t;
    },
  } as unknown as Camera;
}

function makeRenderer(canvas: ReturnType<typeof makeCanvas>, triangles = 0) {
  return {
    domElement: canvas,
    info: { render: { frame: 0, triangles } },
    capabilities: { isWebGL2: true, maxTextureSize: 8192 },
    getContext: () => ({
      VENDOR: 1,
      RENDERER: 2,
      VERSION: 3,
      getExtension: () => null,
      getParameter: () => "x",
    }),
  } as unknown as WebGLRenderer & { info: { render: { frame: number; triangles: number } } };
}

const emptyScene = {} as unknown as Scene;

/** A stub three mesh with an identity world matrix and a local AABB. */
function makeMesh(
  name: string,
  min: [number, number, number],
  max: [number, number, number],
  opts: { visible?: boolean; vertices?: number } = {},
) {
  return {
    isMesh: true,
    name,
    visible: opts.visible ?? true,
    // Column-major identity → world AABB equals the local box.
    matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    geometry: {
      boundingBox: {
        min: { x: min[0], y: min[1], z: min[2] },
        max: { x: max[0], y: max[1], z: max[2] },
      },
      attributes: { position: { count: opts.vertices ?? 100 } },
    },
  };
}

/** A stub scene whose `traverse` walks the supplied meshes. */
function makeMeshScene(meshes: unknown[]): Scene {
  return {
    traverse(cb: (o: unknown) => void) {
      for (const m of meshes) cb(m);
    },
  } as unknown as Scene;
}

function makeCtx(now = { value: 1000 }, config: Record<string, unknown> = {}) {
  const events: EventInput[] = [];
  const ctx = {
    config: config as never,
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

describe("threeCollector", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("normalizes a right-handed camera pose to the canonical frame (ADR 0018)", () => {
    // three world position (1,2,3) → canonical negates Z → (1,2,-3).
    // three world forward (0,0,-1) (local -Z) → canonical (0,0,1) (local +Z).
    const camera = makeCamera({ pos: [1, 2, 3], dir: [0, 0, -1] });
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera,
      renderer: makeRenderer(makeCanvas()),
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
    const camera = makeCamera({ isPerspectiveCamera: true, fov: 90 });
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera,
      renderer: makeRenderer(makeCanvas()),
      capture: { perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample") as { fov?: number };
    expect(cam.fov).toBeCloseTo(Math.PI / 2, 6);
    handle.stop();
  });

  it("attaches a gaze hit-point to camera_sample when gaze capture is enabled (ADR 0030)", () => {
    const camera = makeCamera();
    const { ctx, events } = makeCtx();
    const probe = vi.fn(() => ({ point: [4, 5, 6] as [number, number, number], name: "Wall" }));
    const handle = threeCollector({
      scene: emptyScene,
      camera,
      renderer: makeRenderer(makeCanvas()),
      capture: { perf: false, gaze: true },
      gaze: { probe },
    }).start(ctx)!;

    // three is right-handed → the hit point's Z is negated to the canonical frame.
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
    const handle = threeCollector({
      scene: emptyScene,
      camera,
      renderer: makeRenderer(makeCanvas()),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera,
      renderer: makeRenderer(makeCanvas()),
      capture: { perf: false, gaze: true },
      gaze: { probe: () => undefined },
    }).start(ctx)!;

    const cam = events.find((e) => e.type === "camera_sample");
    expect(cam).not.toHaveProperty("hitPoint");
    expect(cam).not.toHaveProperty("hitMesh");
    handle.stop();
  });

  it("derives frame_perf from the renderer.info frame delta and stops cleanly", () => {
    const canvas = makeCanvas();
    const renderer = makeRenderer(canvas);
    const { ctx, events, now } = makeCtx({ value: 1000 });
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer,
      samplePerfMs: 1000,
      capture: { camera: false },
      raycast: () => undefined,
    }).start(ctx)!;

    // 60 frames advanced over 1 second → 60 fps.
    renderer.info.render.frame = 60;
    now.value = 2000;
    vi.advanceTimersByTime(1000);
    expect(events.find((e) => e.type === "frame_perf")).toMatchObject({
      type: "frame_perf",
      fps: 60,
    });

    handle.stop();
    const before = events.length;
    renderer.info.render.frame = 120;
    now.value = 3000;
    vi.advanceTimersByTime(2000);
    canvas.dispatch("click", { clientX: 1, clientY: 1, button: 0 });
    expect(events.length).toBe(before); // no events after stop
  });

  it("removes every DOM listener, timer, and rAF callback on stop", () => {
    const canvas = makeCanvas();
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
      raycast: () => undefined,
    }).start(ctx)!;

    expect(canvas.count("pointermove")).toBe(1);
    // Two pointerdown/up listeners: one for buttons, one for camera_gesture (ADR 0025).
    expect(canvas.count("pointerdown")).toBe(2);
    expect(canvas.count("pointerup")).toBe(2);
    expect(canvas.count("click")).toBe(1);
    expect(canvas.count("webglcontextlost")).toBe(1);

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

    const before = events.length;
    canvas.dispatch("pointermove", { clientX: 1, clientY: 1 });
    vi.advanceTimersByTime(5000);
    expect(events.length).toBe(before);
  });

  it("normalizes pointer screen coords and a raycast hit (click → pointer_click + mesh_interaction)", () => {
    const canvas = makeCanvas();
    // Hit point is in three's right-handed frame; the collector negates Z.
    const raycast: RaycastProbe = () => ({ point: [4, 5, -6], name: "Cube" });
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
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
    // Record the NDC the connector raycasts at so we can prove it picks centre.
    const ndc: Array<[number, number]> = [];
    const raycast: RaycastProbe = (x, y) => {
      ndc.push([x, y]);
      return { point: [1, 1, -1], name: "Exhibit" };
    };
    const { ctx, events } = makeCtx();

    // Lock the pointer to this canvas. The connector reads
    // `document.pointerLockElement`; stub a minimal document for the node test env.
    const prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { pointerLockElement: canvas };
    try {
      const handle = threeCollector({
        scene: emptyScene,
        camera: makeCamera(),
        renderer: makeRenderer(canvas),
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
      // The raycast ran at the crosshair, not the stale cursor.
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
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
    const dir = { v: [0, 0, -1] as [number, number, number] };
    const camera = {
      isPerspectiveCamera: true,
      fov: 60,
      matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      getWorldPosition(t: { set(x: number, y: number, z: number): unknown }) {
        t.set(0, 0, 10);
        return t;
      },
      getWorldDirection(t: {
        set(x: number, y: number, z: number): typeof t;
        normalize(): typeof t;
        negate(): typeof t;
      }) {
        t.set(-dir.v[0], -dir.v[1], -dir.v[2]).normalize().negate();
        return t;
      },
    } as unknown as Camera;
    const handle = threeCollector({
      scene: emptyScene,
      camera,
      renderer: makeRenderer(canvas),
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
    dir.v = [Math.SQRT1_2, 0, -Math.SQRT1_2];
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera,
      renderer: makeRenderer(makeCanvas()),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas(), 120_000),
      capture: { camera: false, perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

    vi.advanceTimersByTime(60_000);
    expect(events.some((e) => e.type === "resource_sample")).toBe(false);
    handle.stop();
  });

  it("emits a low-rate footprint sample with triangles from renderer.info when enabled (#44)", () => {
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas(), 120_000),
      capture: { camera: false, perf: false, resourceSample: true },
      resourceSample: { intervalMs: 1000 },
      raycast: () => undefined,
    }).start(ctx)!;

    vi.advanceTimersByTime(1000);
    const samples = events.filter((e) => e.type === "resource_sample");
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ type: "resource_sample", triangles: 120_000 });
    // three exposes no vertex count — that metric is omitted, not zeroed.
    expect(samples[0]).not.toHaveProperty("vertices");

    handle.stop();
    // Detached on stop — the timer no longer fires.
    vi.advanceTimersByTime(5000);
    expect(events.filter((e) => e.type === "resource_sample")).toHaveLength(1);
  });

  it("drives a 'frame'-cadence channel with requestAnimationFrame", () => {
    const rafCbs: FrameRequestCallback[] = [];
    const origRaf = globalThis.requestAnimationFrame;
    const origCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    try {
      const { ctx, events } = makeCtx();
      const handle = threeCollector({
        scene: emptyScene,
        camera: makeCamera(),
        renderer: makeRenderer(makeCanvas()),
        suppressIdleSamples: false,
        sampling: { camera: "frame" },
        capture: { perf: false },
        raycast: () => undefined,
      }).start(ctx)!;

      // Initial baseline sample, then one per animation frame — no timer involved.
      expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(1);
      rafCbs.shift()!(0);
      rafCbs.shift()!(0);
      expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(3);

      handle.stop();
      rafCbs.shift()?.(0); // cancelled on stop → no further samples
      expect(events.filter((e) => e.type === "camera_sample")).toHaveLength(3);
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancel;
    }
  });

  // --- mesh_visibility (#37) — per-object dwell, opt-in ---

  it("emits one bucketed mesh_visibility summary per visible object per window (#37)", () => {
    const rafCbs: FrameRequestCallback[] = [];
    const origRaf = globalThis.requestAnimationFrame;
    const origCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    try {
      const now = { value: 1000 };
      const { ctx, events } = makeCtx(now);
      // Camera at (1,2,3) looking down −Z (three forward). One mesh ahead, one behind.
      const scene = makeMeshScene([
        makeMesh("product-hero", [0.5, 1.5, -15], [1.5, 2.5, -13]),
        makeMesh("backdrop", [0, 0, 13], [1, 1, 15]),
      ]);
      const handle = threeCollector({
        scene,
        camera: makeCamera({ pos: [1, 2, 3], dir: [0, 0, -1] }),
        renderer: makeRenderer(makeCanvas()),
        capture: { camera: false, perf: false, meshVisibility: true },
        meshVisibility: { windowMs: 1000 },
        raycast: () => undefined,
      }).start(ctx)!;

      // 10 animation frames, 100ms apart → 1000ms on-screen for the front mesh.
      for (let i = 0; i < 10; i++) {
        now.value += 100;
        rafCbs.shift()!(0);
      }
      vi.advanceTimersByTime(1000); // window flush

      const vis = events.filter((e) => e.type === "mesh_visibility");
      // Only the mesh in front of the camera is visible (frustum / half-space test).
      expect(vis).toHaveLength(1);
      expect(vis[0]).toMatchObject({ type: "mesh_visibility", mesh: "product-hero" });
      expect((vis[0] as unknown as { visibleMs: number }).visibleMs).toBe(1000);
      expect((vis[0] as unknown as { centeredMs: number }).centeredMs).toBe(1000);
      handle.stop();
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancel;
    }
  });

  it("rides the world AABB along once per object when boundingBox is on (#53)", () => {
    const rafCbs: FrameRequestCallback[] = [];
    const origRaf = globalThis.requestAnimationFrame;
    const origCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    try {
      const now = { value: 1000 };
      const { ctx, events } = makeCtx(now);
      const scene = makeMeshScene([makeMesh("product-hero", [0.5, 1.5, -15], [1.5, 2.5, -13])]);
      const handle = threeCollector({
        scene,
        camera: makeCamera({ pos: [1, 2, 3], dir: [0, 0, -1] }),
        renderer: makeRenderer(makeCanvas()),
        capture: { camera: false, perf: false, meshVisibility: true },
        meshVisibility: { windowMs: 1000, boundingBox: true },
        raycast: () => undefined,
      }).start(ctx)!;

      // First window: bounds ride along (canonical frame negates Z).
      for (let i = 0; i < 5; i++) {
        now.value += 100;
        rafCbs.shift()!(0);
      }
      vi.advanceTimersByTime(1000);
      // Second window: bounds unchanged, so they are NOT re-sent.
      for (let i = 0; i < 5; i++) {
        now.value += 100;
        rafCbs.shift()!(0);
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
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancel;
    }
  });

  it("omits the AABB unless boundingBox capture is enabled (#53)", () => {
    const rafCbs: FrameRequestCallback[] = [];
    const origRaf = globalThis.requestAnimationFrame;
    const origCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    try {
      const now = { value: 1000 };
      const { ctx, events } = makeCtx(now);
      const scene = makeMeshScene([makeMesh("product-hero", [0.5, 1.5, -15], [1.5, 2.5, -13])]);
      const handle = threeCollector({
        scene,
        camera: makeCamera({ pos: [1, 2, 3], dir: [0, 0, -1] }),
        renderer: makeRenderer(makeCanvas()),
        capture: { camera: false, perf: false, meshVisibility: true },
        meshVisibility: { windowMs: 1000 },
        raycast: () => undefined,
      }).start(ctx)!;

      for (let i = 0; i < 5; i++) {
        now.value += 100;
        rafCbs.shift()!(0);
      }
      vi.advanceTimersByTime(1000);

      const vis = events.filter((e) => e.type === "mesh_visibility") as unknown as {
        bounds?: number[];
      }[];
      expect(vis).toHaveLength(1);
      expect(vis[0]!.bounds).toBeUndefined();
      handle.stop();
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancel;
    }
  });

  it("does not capture mesh_visibility unless explicitly enabled (#37, ADR 0003)", () => {
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const scene = makeMeshScene([makeMesh("product-hero", [0.5, 1.5, -15], [1.5, 2.5, -13])]);
    const handle = threeCollector({
      scene,
      camera: makeCamera({ pos: [1, 2, 3], dir: [0, 0, -1] }),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      raycast: () => undefined,
    }).start(ctx)!;

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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(canvas),
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

describe("threeCollector — WebGPU device.lost → graphics_diagnostic (#20)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * A WebGPURenderer whose `backend.device.lost` promise resolves on `lose(...)`.
   * Pass `deferDevice: true` to start with `backend.device` undefined (mirrors
   * WebGPURenderer's async `init()`) and attach it later via `provideDevice()`.
   */
  function makeWebGpuRenderer(
    canvas: ReturnType<typeof makeCanvas>,
    opts: { deferDevice?: boolean } = {},
  ) {
    let resolveLost!: (info: { reason?: string; message?: string }) => void;
    const lost = new Promise<{ reason?: string; message?: string }>((r) => {
      resolveLost = r;
    });
    const backend: { device?: { lost: Promise<{ reason?: string; message?: string }> } } = {
      device: opts.deferDevice ? undefined : { lost },
    };
    const renderer = {
      domElement: canvas,
      isWebGPURenderer: true,
      info: { render: { frame: 0, triangles: 0 } },
      backend,
    } as unknown as WebGLRenderer;
    return {
      renderer,
      provideDevice: () => {
        backend.device = { lost };
      },
      lose: async (info: { reason?: string; message?: string }) => {
        resolveLost(info);
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  function start(renderer: WebGLRenderer, config: Record<string, unknown>) {
    const { ctx, events } = makeCtx(undefined, config);
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer,
      capture: { camera: false, perf: false },
      raycast: () => undefined,
    }).start(ctx)!;
    return { events, handle };
  }

  it("emits nothing when captureGraphicsDiagnostics is off", async () => {
    const { renderer, lose } = makeWebGpuRenderer(makeCanvas());
    const { events, handle } = start(renderer, { captureGraphicsDiagnostics: false });

    await lose({ reason: "unknown", message: "boom" });
    expect(events.some((e) => e.type === "graphics_diagnostic")).toBe(false);
    handle.stop();
  });

  it("emits exactly one fatal device-lost diagnostic when enabled", async () => {
    const { renderer, lose } = makeWebGpuRenderer(makeCanvas());
    const { events, handle } = start(renderer, { captureGraphicsDiagnostics: true });

    await lose({ reason: "unknown", message: "device removed" });

    const diags = events.filter((e) => e.type === "graphics_diagnostic");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toEqual({
      type: "graphics_diagnostic",
      severity: "fatal",
      category: "device-lost",
      backend: "webgpu",
      message: "device removed",
    });
    handle.stop();
  });

  it("maps reason 'destroyed' to info severity", async () => {
    const { renderer, lose } = makeWebGpuRenderer(makeCanvas());
    const { events, handle } = start(renderer, { captureGraphicsDiagnostics: true });

    await lose({ reason: "destroyed" });

    const diags = events.filter((e) => e.type === "graphics_diagnostic");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "info",
      category: "device-lost",
      backend: "webgpu",
    });
    handle.stop();
  });

  it("does not emit after the collector has stopped", async () => {
    const { renderer, lose } = makeWebGpuRenderer(makeCanvas());
    const { events, handle } = start(renderer, { captureGraphicsDiagnostics: true });

    handle.stop();
    await lose({ reason: "unknown" });
    expect(events.some((e) => e.type === "graphics_diagnostic")).toBe(false);
  });

  it("wires device.lost even when the device initializes asynchronously after start()", async () => {
    const { renderer, provideDevice, lose } = makeWebGpuRenderer(makeCanvas(), {
      deferDevice: true,
    });
    const { events, handle } = start(renderer, { captureGraphicsDiagnostics: true });

    // Device not ready yet at start() — the loss must not be missed.
    expect(events.some((e) => e.type === "graphics_diagnostic")).toBe(false);

    provideDevice();
    await vi.advanceTimersByTimeAsync(300);
    await lose({ reason: "unknown", message: "late device removed" });

    const diags = events.filter((e) => e.type === "graphics_diagnostic");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "fatal",
      category: "device-lost",
      backend: "webgpu",
    });
    handle.stop();
  });

  it("never wires device.lost if the renderer is disposed before the device appears", async () => {
    const { renderer, provideDevice, lose } = makeWebGpuRenderer(makeCanvas(), {
      deferDevice: true,
    });
    const { events, handle } = start(renderer, { captureGraphicsDiagnostics: true });

    // Tear down before the async WebGPU device ever initializes.
    handle.stop();
    provideDevice();
    await vi.advanceTimersByTimeAsync(2000);
    await lose({ reason: "unknown", message: "too late" });

    expect(events.some((e) => e.type === "graphics_diagnostic")).toBe(false);
  });

  it("is a no-op on a WebGL renderer (no device-lost concept)", async () => {
    const canvas = makeCanvas();
    const { events, handle } = start(makeRenderer(canvas), { captureGraphicsDiagnostics: true });

    // A WebGL context loss is a context_lost, never a graphics_diagnostic.
    canvas.dispatch("webglcontextlost", {});
    await Promise.resolve();
    expect(events.some((e) => e.type === "graphics_diagnostic")).toBe(false);
    handle.stop();
  });
});

describe("threeCollector — WebGPU uncapturederror rollup → graphics_diagnostic (#19)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeWebGpuErrorRenderer(canvas: ReturnType<typeof makeCanvas>) {
    let handler: ((e: { error?: unknown }) => void) | undefined;
    const device = {
      lost: new Promise(() => {}),
      addEventListener: (_t: string, h: (e: { error?: unknown }) => void) => (handler = h),
      removeEventListener: () => (handler = undefined),
    };
    const renderer = {
      domElement: canvas,
      isWebGPURenderer: true,
      info: { render: { frame: 0, triangles: 0 } },
      backend: { device },
    } as unknown as WebGLRenderer;
    return { renderer, fire: (error: unknown) => handler?.({ error }) };
  }

  function start(renderer: WebGLRenderer, config: Record<string, unknown>) {
    const { ctx, events } = makeCtx(undefined, config);
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer,
      capture: { camera: false, perf: false },
      raycast: () => undefined,
    }).start(ctx)!;
    return { events, handle };
  }

  it("collapses a burst into one rollup on stop, not N events", () => {
    const { renderer, fire } = makeWebGpuErrorRenderer(makeCanvas());
    const { events, handle } = start(renderer, { captureGraphicsDiagnostics: true });
    for (let i = 0; i < 30; i++)
      fire({ message: `e${i}`, constructor: { name: "GPUValidationError" } });
    handle.stop();
    const diags = events.filter((e) => e.type === "graphics_diagnostic");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      category: "validation",
      count: 30,
      backend: "webgpu",
      message: "e0",
    });
  });

  it("emits nothing when the flag is off", () => {
    const { renderer, fire } = makeWebGpuErrorRenderer(makeCanvas());
    const { events, handle } = start(renderer, { captureGraphicsDiagnostics: false });
    fire({ message: "x", constructor: { name: "GPUValidationError" } });
    handle.stop();
    expect(events.some((e) => e.type === "graphics_diagnostic")).toBe(false);
  });
});

describe("threeCollector — scene actors / node_transform (ADR 0027 Tier 1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Column-major identity world matrix with a translation; rotation identity,
  // scale 1. Lets the decomposer return a clean canonical sample.
  function makeNode(over: Record<string, unknown> = {}) {
    return {
      updateWorldMatrix: vi.fn(),
      matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] },
      ...over,
    };
  }

  it("emits a node_transform with the canonical world transform (Z negated)", () => {
    const node = makeNode();
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { door: node },
      sampling: { nodes: { door: 10 } },
    }).start(ctx)!;

    const nt = events.find((e) => e.type === "node_transform");
    // three position (1,2,3) → canonical negates Z → (1,2,-3); identity rotation.
    expect(nt).toMatchObject({
      type: "node_transform",
      nodeId: "door",
      position: [1, 2, -3],
      rotation: [0, 0, 0, 1],
    });
    expect((nt as Record<string, unknown>).scale).toBeUndefined();
    expect(node.updateWorldMatrix).toHaveBeenCalledWith(true, false);
    handle.stop();
  });

  it("includes non-identity scale (invariant under the handedness reflection)", () => {
    // Column 0 length 2, column 1 length 2, column 2 length 2 → scale (2,2,2).
    const node = makeNode({
      matrixWorld: { elements: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1] },
    });
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { lift: node },
      sampling: { nodes: { lift: 10 } },
    }).start(ctx)!;

    expect(events.find((e) => e.type === "node_transform")).toMatchObject({
      nodeId: "lift",
      scale: [2, 2, 2],
    });
    handle.stop();
  });

  it("does not capture an actor without a sampling.nodes rate (default OFF)", () => {
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { door: makeNode() },
    }).start(ctx)!;

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
  });

  it("warns and ignores a sampling.nodes id with no matching actor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      sampling: { nodes: { ghost: 10 } },
    }).start(ctx)!;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
    warn.mockRestore();
  });

  it("resolves a string actor via scene.getObjectByName", () => {
    const node = makeNode();
    const scene = {
      getObjectByName: (n: string) => (n === "npc" ? node : null),
    } as unknown as Scene;
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { npc: "npc" },
      sampling: { nodes: { npc: 10 } },
    }).start(ctx)!;

    expect(events.find((e) => e.type === "node_transform")).toMatchObject({ nodeId: "npc" });
    handle.stop();
  });

  it("refuses to capture a node that is a camera (events live once)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cam = makeNode({ isCamera: true });
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { cam },
      sampling: { nodes: { cam: 10 } },
    }).start(ctx)!;

    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("camera"));
    handle.stop();
    warn.mockRestore();
  });

  it("suppresses idle samples when the transform is unchanged", () => {
    const node = makeNode();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { door: node },
      sampling: { nodes: { door: 10 } }, // 100 ms interval
    }).start(ctx)!;

    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);

    node.matrixWorld = { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9, 9, 9, 1] };
    vi.advanceTimersByTime(100);
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(2);
    handle.stop();
  });

  it("captures a subtree with childPath when include is set (ADR 0033)", () => {
    // Root 'rig' with a child 'Body' that itself parents 'Hand'. include:"*"
    // walks the whole bounded hierarchy and emits one sample per descendant,
    // each carrying its '/'-joined path from the actor.
    const hand = makeNode({
      name: "Hand",
      matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1] },
      children: [],
    });
    const body = makeNode({
      name: "Body",
      matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1] },
      children: [hand],
    });
    const rig = makeNode({ name: "rig", children: [body] });
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { rig },
      sampling: { nodes: { rig: { hz: 10, include: "*" } } },
    }).start(ctx)!;

    const nts = events.filter((e) => e.type === "node_transform") as Array<Record<string, unknown>>;
    // Root (no childPath) + Body + Body/Hand.
    expect(nts).toHaveLength(3);
    expect(nts[0]).toMatchObject({ nodeId: "rig", position: [1, 2, -3] });
    expect(nts[0].childPath).toBeUndefined();
    expect(nts.find((e) => e.childPath === "Body")).toMatchObject({
      nodeId: "rig",
      position: [0, 5, 0],
    });
    expect(nts.find((e) => e.childPath === "Body/Hand")).toMatchObject({
      nodeId: "rig",
      position: [4, 0, 0],
    });
    handle.stop();
  });

  it("limits subtree capture to the include allowlist and respects maxDepth (ADR 0033)", () => {
    const hand = makeNode({ name: "Hand", children: [] });
    const body = makeNode({ name: "Body", children: [hand] });
    const rig = makeNode({ name: "rig", children: [body] });
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { rig },
      // Only 'Hand' is allowlisted, but maxDepth 1 stops before reaching it.
      sampling: { nodes: { rig: { hz: 10, include: ["Hand"], maxDepth: 1 } } },
    }).start(ctx)!;

    const nts = events.filter((e) => e.type === "node_transform") as Array<Record<string, unknown>>;
    // Only the root is emitted: 'Hand' is at depth 2, beyond maxDepth 1.
    expect(nts).toHaveLength(1);
    expect(nts[0].childPath).toBeUndefined();
    handle.stop();
  });
});

describe("threeCollector — skeleton bones / node_transform (ADR 0027 Tier 2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A three `Bone` (Object3D) exposing its parent-relative local TRS directly. */
  function makeBone(
    name: string,
    p: [number, number, number] = [0, 0, 0],
    q: [number, number, number, number] = [0, 0, 0, 1],
    s: [number, number, number] = [1, 1, 1],
  ) {
    return {
      name,
      position: { x: p[0], y: p[1], z: p[2] },
      quaternion: { x: q[0], y: q[1], z: q[2], w: q[3] },
      scale: { x: s[0], y: s[1], z: s[2] },
    };
  }

  /** A SkinnedMesh-like actor carrying a skeleton with the given bones. */
  function makeSkinned(bones: Array<ReturnType<typeof makeBone>>) {
    return { updateWorldMatrix: vi.fn(), skeleton: { bones } };
  }

  it("emits a Tier-2 node_transform (boneId + canonical local pose) for an allowlisted bone", () => {
    const hand = makeBone("RightHand", [1, 2, 3]);
    const node = makeSkinned([makeBone("Hips"), hand]);
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { guard: node },
      sampling: { bones: { guard: { include: ["RightHand"], hz: 30 } } },
    }).start(ctx)!;

    const nt = events.find((e) => e.type === "node_transform");
    // three local (1,2,3) → canonical negates Z → (1,2,-3); identity rotation.
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
    // three quat [0,0,1,0] (RotZ 180°) → canonical reflect → [-0,-0,1,0] = [0,0,1,0].
    const head = makeBone("Head", [0, 0, 0], [0, 0, 1, 0], [2, 2, 2]);
    const node = makeSkinned([head]);
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
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
    const node = makeSkinned([
      makeBone("Hips", [0, 0, 0]),
      makeBone("Spine", [0, 1, 0]),
      makeBone("Head", [0, 2, 0]),
    ]);
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
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
    const node = makeSkinned([makeBone("Hips")]);
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { guard: node },
    }).start(ctx)!;

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
  });

  it("warns and ignores a sampling.bones id with no matching actor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
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
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { guard: node },
      sampling: { bones: { guard: { include: ["NoSuchBone"], hz: 30 } } },
    }).start(ctx)!;

    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skeleton bones"));
    handle.stop();
    warn.mockRestore();
  });

  it("suppresses idle bone samples until a bone's local pose changes", () => {
    const bone = makeBone("Hips", [0, 0, 0]);
    const node = makeSkinned([bone]);
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false },
      actors: { guard: node },
      sampling: { bones: { guard: { include: ["Hips"], hz: 10 } } }, // 100 ms interval
    }).start(ctx)!;

    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);
    vi.advanceTimersByTime(300); // pose unchanged
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);

    bone.position = { x: 5, y: 0, z: 0 }; // pose moves → next tick emits
    vi.advanceTimersByTime(100);
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(2);
    handle.stop();
  });

  it("respects capture.bones = false even when sampling.bones is configured", () => {
    const node = makeSkinned([makeBone("Hips")]);
    const { ctx, events } = makeCtx();
    const handle = threeCollector({
      scene: emptyScene,
      camera: makeCamera(),
      renderer: makeRenderer(makeCanvas()),
      capture: { camera: false, perf: false, bones: false },
      actors: { guard: node },
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
      const handle = threeCollector({
        scene: emptyScene,
        camera: makeCamera(),
        renderer: makeRenderer(makeCanvas()),
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

      // Listeners are torn down on stop.
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
      const handle = threeCollector({
        scene: emptyScene,
        camera: makeCamera(),
        renderer: makeRenderer(makeCanvas()),
        capture: { camera: false, perf: false },
        raycast: () => undefined,
      }).start(ctx)!;

      // No keydown listener was registered, so nothing is captured.
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
