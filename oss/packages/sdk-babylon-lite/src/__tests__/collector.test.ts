import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Camera, SceneContext } from "@babylonjs/lite";
import type { CollectorContext, EventInput } from "@uptimizr/sdk-core";
import { liteCollector } from "../collector.js";
import type { LitePickProbe } from "../picker.js";

/** Drain a few microtask turns so async pick → emit chains settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A stub host canvas that records DOM listeners and can dispatch events. */
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
  /** World matrix translation [12,13,14]. */
  pos?: [number, number, number];
  /** World +Z basis [8,9,10] (forward). */
  forward?: [number, number, number];
  fov?: number;
  /** ArcRotate-only fields. */
  alpha?: number;
  target?: [number, number, number];
}

/** A stub Lite camera exposing a 16-length world matrix + optional arc fields. */
function makeCamera(cfg: CameraConfig = {}): Camera {
  const pos = cfg.pos ?? [0, 0, 0];
  const fwd = cfg.forward ?? [0, 0, 1];
  const wm = new Array<number>(16).fill(0);
  wm[8] = fwd[0];
  wm[9] = fwd[1];
  wm[10] = fwd[2];
  wm[12] = pos[0];
  wm[13] = pos[1];
  wm[14] = pos[2];
  wm[15] = 1;
  const cam: Record<string, unknown> = { worldMatrix: wm, fov: cfg.fov };
  if (cfg.alpha !== undefined) cam.alpha = cfg.alpha;
  if (cfg.target) cam.target = { x: cfg.target[0], y: cfg.target[1], z: cfg.target[2] };
  return cam as unknown as Camera;
}

const emptyScene = { meshes: [] } as unknown as SceneContext;

/** A stub picker that always resolves to a fixed hit. */
function makePicker(hit?: { point?: [number, number, number]; mesh?: string }): LitePickProbe {
  return {
    pick: vi.fn(async () => (hit ? { point: hit.point, mesh: hit.mesh } : undefined)),
    dispose: vi.fn(),
  };
}

function makeCtx(now = { value: 1000 }) {
  const events: EventInput[] = [];
  const ctx = {
    config: {} as never,
    sessionId: "s1",
    emit: (e: EventInput) => events.push(e),
    track: () => {},
    setScene: () => {},
    now: () => now.value,
  } satisfies CollectorContext;
  return { ctx, events, now };
}

describe("liteCollector — camera", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("extracts position [12,13,14] and forward [8,9,10] from the world matrix", () => {
    const camera = makeCamera({ pos: [1, 2, 3], forward: [0, 0, 1], fov: 0.8 });
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera,
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      capture: {
        camera: true,
        perf: false,
        pointerMove: false,
        clicks: false,
        buttons: false,
        meshPicks: false,
      },
    }).start(ctx);

    // Lite is left-handed → canonical is identity.
    const sample = events.find((e) => e.type === "camera_sample");
    expect(sample).toMatchObject({ position: [1, 2, 3], direction: [0, 0, 1], fov: 0.8 });
    handle.stop();
  });

  it("emits a look-at target for an ArcRotate camera", () => {
    const camera = makeCamera({ pos: [0, 0, 0], alpha: 1.5, target: [5, 0, -2] });
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera,
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      capture: {
        camera: true,
        perf: false,
        pointerMove: false,
        clicks: false,
        buttons: false,
        meshPicks: false,
      },
    }).start(ctx);

    const sample = events.find((e) => e.type === "camera_sample");
    expect(sample).toMatchObject({ target: [5, 0, -2] });
    handle.stop();
  });
});

describe("liteCollector — gaze", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const gazeCapture = {
    camera: true,
    perf: false,
    pointerMove: false,
    clicks: false,
    buttons: false,
    meshPicks: false,
  };

  it("attaches a cached center-pixel hit to a later camera_sample (ADR 0030)", async () => {
    // Lite picks asynchronously, so the hit rides the NEXT emitted sample.
    const picker = makePicker({ point: [4, 5, 6], mesh: "Wall" });
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera({ pos: [0, 0, 0] }),
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      sampleCameraMs: 1000,
      suppressIdleSamples: false,
      capture: { ...gazeCapture, gaze: true },
      picker,
    }).start(ctx);

    await flush(); // let the primed center-pixel pick resolve
    vi.advanceTimersByTime(1000); // next camera sample carries the cached hit

    // Lite is left-handed → canonical is identity.
    const withGaze = events
      .filter((e) => e.type === "camera_sample")
      .find((e) => "hitPoint" in e);
    expect(withGaze).toMatchObject({ hitPoint: [4, 5, 6], hitMesh: "Wall" });
    handle.stop();
  });

  it("never picks and omits gaze fields when gaze capture is disabled", async () => {
    const picker = makePicker({ point: [4, 5, 6], mesh: "Wall" });
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera({ pos: [0, 0, 0] }),
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      sampleCameraMs: 1000,
      suppressIdleSamples: false,
      capture: { ...gazeCapture, gaze: false },
      picker,
    }).start(ctx);

    await flush();
    vi.advanceTimersByTime(1000);

    const withGaze = events
      .filter((e) => e.type === "camera_sample")
      .find((e) => "hitPoint" in e);
    expect(withGaze).toBeUndefined();
    expect(picker.pick).not.toHaveBeenCalled();
    handle.stop();
  });

  it("leaves gaze fields unset on a center-pixel miss", async () => {
    const picker = makePicker(); // resolves to undefined (no hit)
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera({ pos: [0, 0, 0] }),
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      sampleCameraMs: 1000,
      suppressIdleSamples: false,
      capture: { ...gazeCapture, gaze: true },
      picker,
    }).start(ctx);

    await flush();
    vi.advanceTimersByTime(1000);

    const withGaze = events
      .filter((e) => e.type === "camera_sample")
      .find((e) => "hitPoint" in e);
    expect(withGaze).toBeUndefined();
    expect(picker.pick).toHaveBeenCalled();
    handle.stop();
  });
});

describe("liteCollector — perf", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("derives FPS from the injected frame hook's deltaMs", () => {
    let frameCb: ((deltaMs: number) => void) | undefined;
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      samplePerfMs: 1000,
      frameHook: (_scene, cb) => {
        frameCb = cb;
      },
      capture: {
        camera: false,
        perf: true,
        pointerMove: false,
        clicks: false,
        buttons: false,
        meshPicks: false,
      },
    }).start(ctx);

    // Drive a few 20ms frames (≈50fps) then let the perf timer fire.
    for (let i = 0; i < 5; i++) frameCb?.(20);
    vi.advanceTimersByTime(1000);

    const perf = events.find((e) => e.type === "frame_perf") as { fps: number } | undefined;
    expect(perf).toBeDefined();
    expect(perf!.fps).toBeGreaterThan(40);
    expect(perf!.fps).toBeLessThan(60);
    handle.stop();
  });
});

describe("liteCollector — pointer/picking", () => {
  it("emits pointer_click and mesh_interaction from a stub pick", async () => {
    const canvas = makeCanvas();
    const picker = makePicker({ point: [2, 0, -1], mesh: "box-3" });
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvas as unknown as HTMLCanvasElement,
      picker,
      capture: {
        camera: false,
        perf: false,
        pointerMove: false,
        clicks: true,
        buttons: false,
        meshPicks: true,
      },
    }).start(ctx);

    canvas.dispatch("click", { clientX: 400, clientY: 300, button: 0, pointerType: "mouse" });
    await flush();

    const click = events.find((e) => e.type === "pointer_click");
    const pick = events.find((e) => e.type === "mesh_interaction");
    // Screen is normalized top-left; 400/800, 300/600 = center.
    expect(click).toMatchObject({
      screen: [0.5, 0.5],
      hitPoint: [2, 0, -1],
      hitMesh: "box-3",
      button: 0,
      source: "mouse",
    });
    expect(pick).toMatchObject({ mesh: "box-3", kind: "pick", point: [2, 0, -1] });
    handle.stop();
  });

  it("disposes a connector-owned picker and detaches listeners on stop", () => {
    const canvas = makeCanvas();
    const picker = makePicker();
    const { ctx } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvas as unknown as HTMLCanvasElement,
      picker,
      capture: {
        camera: false,
        perf: false,
        pointerMove: true,
        clicks: true,
        buttons: true,
        meshPicks: true,
      },
    }).start(ctx);

    expect(canvas.count("click")).toBe(1);
    handle.stop();
    expect(canvas.count("click")).toBe(0);
    // A caller-supplied picker is the caller's to dispose — the connector must not.
    expect(picker.dispose).not.toHaveBeenCalled();
  });
});

describe("liteCollector — camera_gesture (ADR 0025)", () => {
  it("emits an orbit gesture when the view turns between pointer down and up", () => {
    const canvas = makeCanvas();
    // ArcRotate-style camera: explicit pivot (target) + alpha.
    const camera = makeCamera({
      pos: [0, 0, -10],
      forward: [0, 0, 1],
      alpha: 1.5,
      target: [0, 0, 0],
    });
    const wm = (camera as unknown as { worldMatrix: number[] }).worldMatrix;
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = liteCollector({
      scene: emptyScene,
      camera,
      canvas: canvas as unknown as HTMLCanvasElement,
      capture: {
        camera: false,
        perf: false,
        pointerMove: false,
        clicks: false,
        buttons: false,
        meshPicks: false,
      },
    }).start(ctx);

    canvas.dispatch("pointerdown", { clientX: 400, clientY: 300, button: 0, pointerType: "mouse" });
    // Turn the forward ~45° around the pivot.
    wm[8] = Math.SQRT1_2;
    wm[10] = Math.SQRT1_2;
    now.value = 1400;
    canvas.dispatch("pointerup", { clientX: 500, clientY: 300, button: 0, pointerType: "mouse" });

    const gesture = events.find((e) => e.type === "camera_gesture");
    expect(gesture).toMatchObject({
      type: "camera_gesture",
      kind: "orbit",
      durationMs: 400,
      source: "mouse",
    });
    expect((gesture as { orbitDeg: number }).orbitDeg).toBeGreaterThan(40);
    expect(gesture).not.toHaveProperty("mesh");
    handle.stop();
  });

  it("does not emit a camera_gesture when the camera holds still", () => {
    const canvas = makeCanvas();
    const camera = makeCamera({
      pos: [0, 0, -10],
      forward: [0, 0, 1],
      alpha: 1.5,
      target: [0, 0, 0],
    });
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera,
      canvas: canvas as unknown as HTMLCanvasElement,
      capture: {
        camera: false,
        perf: false,
        pointerMove: false,
        clicks: false,
        buttons: false,
        meshPicks: false,
      },
    }).start(ctx);

    canvas.dispatch("pointerdown", { clientX: 400, clientY: 300, button: 0, pointerType: "mouse" });
    canvas.dispatch("pointerup", { clientX: 400, clientY: 300, button: 0, pointerType: "mouse" });

    expect(events.some((e) => e.type === "camera_gesture")).toBe(false);
    handle.stop();
  });

  it("does not attach gesture listeners when cameraGesture is disabled", () => {
    const canvas = makeCanvas();
    const { ctx } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvas as unknown as HTMLCanvasElement,
      capture: {
        camera: false,
        perf: false,
        pointerMove: false,
        clicks: false,
        buttons: false,
        meshPicks: false,
        cameraGesture: false,
      },
    }).start(ctx);

    expect(canvas.count("pointerdown")).toBe(0);
    expect(canvas.count("pointerup")).toBe(0);
    handle.stop();
  });
});

describe("liteCollector — scene actors / node_transform (ADR 0027 Tier 1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A column-major world matrix with identity rotation, given translation + scale. */
  function makeNode(
    pos: [number, number, number] = [1, 2, 3],
    scale: [number, number, number] = [1, 1, 1],
    over: Record<string, unknown> = {},
  ) {
    const wm = new Array<number>(16).fill(0);
    wm[0] = scale[0];
    wm[5] = scale[1];
    wm[10] = scale[2];
    wm[12] = pos[0];
    wm[13] = pos[1];
    wm[14] = pos[2];
    wm[15] = 1;
    return { worldMatrix: wm, ...over };
  }

  const canvasOpt = () => makeCanvas() as unknown as HTMLCanvasElement;
  const baseCapture = {
    camera: false,
    perf: false,
    pointerMove: false,
    clicks: false,
    buttons: false,
    meshPicks: false,
    cameraGesture: false,
  };

  it("emits a node_transform with the world transform (Lite is canonical, no convert)", () => {
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvasOpt(),
      capture: baseCapture,
      actors: { lift: makeNode([1, 2, 3]) },
      sampling: { nodes: { lift: 10 } },
    }).start(ctx);

    const nt = events.find((e) => e.type === "node_transform");
    expect(nt).toMatchObject({
      type: "node_transform",
      nodeId: "lift",
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
    });
    expect((nt as Record<string, unknown>).scale).toBeUndefined();
    handle.stop();
  });

  it("includes non-identity scale", () => {
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvasOpt(),
      capture: baseCapture,
      actors: { lift: makeNode([0, 0, 0], [2, 3, 4]) },
      sampling: { nodes: { lift: 10 } },
    }).start(ctx);

    expect(events.find((e) => e.type === "node_transform")).toMatchObject({
      scale: [2, 3, 4],
    });
    handle.stop();
  });

  it("does not capture an actor without a sampling.nodes rate (default OFF)", () => {
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvasOpt(),
      capture: baseCapture,
      actors: { lift: makeNode() },
    }).start(ctx);

    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
  });

  it("warns and ignores a sampling.nodes id with no matching actor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvasOpt(),
      capture: baseCapture,
      sampling: { nodes: { ghost: 10 } },
    }).start(ctx);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    handle.stop();
    warn.mockRestore();
  });

  it("resolves a string actor via scene.meshes[].name", () => {
    const scene = {
      meshes: [{ name: "Patrol", ...makeNode([5, 0, 7]) }],
    } as unknown as SceneContext;
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene,
      camera: makeCamera(),
      canvas: canvasOpt(),
      capture: baseCapture,
      actors: { guard: "Patrol" },
      sampling: { nodes: { guard: 10 } },
    }).start(ctx);

    expect(events.find((e) => e.type === "node_transform")).toMatchObject({
      nodeId: "guard",
      position: [5, 0, 7],
    });
    handle.stop();
  });

  it("refuses to capture a node that is a camera (events live once)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cam = makeNode([0, 0, 0], [1, 1, 1], { fov: 0.8 });
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvasOpt(),
      capture: baseCapture,
      actors: { cam },
      sampling: { nodes: { cam: 10 } },
    }).start(ctx);

    expect(events.some((e) => e.type === "node_transform")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("camera"));
    handle.stop();
    warn.mockRestore();
  });

  it("suppresses idle samples when the transform is unchanged", () => {
    const wm = new Array<number>(16).fill(0);
    wm[0] = 1;
    wm[5] = 1;
    wm[10] = 1;
    wm[12] = 1;
    wm[13] = 2;
    wm[14] = 3;
    wm[15] = 1;
    const node = { worldMatrix: wm };
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvasOpt(),
      capture: baseCapture,
      actors: { lift: node },
      sampling: { nodes: { lift: 10 } }, // 100 ms interval
    }).start(ctx);

    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(1);

    wm[14] = 9;
    vi.advanceTimersByTime(100);
    expect(events.filter((e) => e.type === "node_transform")).toHaveLength(2);
    handle.stop();
  });
});

describe("liteCollector — mesh_visibility (#37)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const offCapture = {
    camera: false,
    perf: false,
    pointerMove: false,
    clicks: false,
    buttons: false,
    meshPicks: false,
    cameraGesture: false,
  };

  /** A scene whose meshes carry loader-style world bounds (boundMin/boundMax). */
  function visScene(
    meshes: Array<{
      name: string;
      visible?: boolean;
      boundMin?: [number, number, number];
      boundMax?: [number, number, number];
    }>,
  ): SceneContext {
    return { meshes } as unknown as SceneContext;
  }

  it("does not capture mesh_visibility by default (opt-in, ADR 0003)", () => {
    const scene = visScene([{ name: "front", boundMin: [-1, -1, 4], boundMax: [1, 1, 6] }]);
    let frameCb: ((deltaMs: number) => void) | undefined;
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = liteCollector({
      scene,
      camera: makeCamera({ pos: [0, 0, 0], forward: [0, 0, 1], fov: 0.8 }),
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      frameHook: (_s, cb) => {
        frameCb = cb;
      },
      capture: offCapture,
    }).start(ctx);

    now.value = 1100;
    frameCb?.(100);
    vi.advanceTimersByTime(5000);
    expect(events.some((e) => e.type === "mesh_visibility")).toBe(false);
    handle.stop();
  });

  it("accumulates on-screen + centered time and flushes one summary per window (#37)", () => {
    const scene = visScene([
      { name: "front", boundMin: [-1, -1, 4], boundMax: [1, 1, 6] },
      // Behind the camera (left-handed forward +Z): excluded by the frustum test.
      { name: "behind", boundMin: [-1, -1, -6], boundMax: [1, 1, -4] },
    ]);
    let frameCb: ((deltaMs: number) => void) | undefined;
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = liteCollector({
      scene,
      camera: makeCamera({ pos: [0, 0, 0], forward: [0, 0, 1], fov: 0.8 }),
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      frameHook: (_s, cb) => {
        frameCb = cb;
      },
      capture: { ...offCapture, meshVisibility: true },
      meshVisibility: { windowMs: 5000 },
    }).start(ctx);

    now.value = 1100;
    frameCb?.(100);
    now.value = 1200;
    frameCb?.(100);
    vi.advanceTimersByTime(5000);

    const vis = events.filter((e) => e.type === "mesh_visibility");
    expect(vis).toHaveLength(1);
    expect(vis[0]).toMatchObject({ type: "mesh_visibility", mesh: "front", visibleMs: 200 });
    // Dead-centre object → fully centered; some screen coverage measured.
    expect((vis[0] as { centeredMs?: number }).centeredMs).toBe(200);
    expect((vis[0] as { maxScreenFraction?: number }).maxScreenFraction).toBeGreaterThan(0);
    handle.stop();
  });

  it("includes the world AABB when boundingBox is enabled (Lite left-handed, no Z flip) (#37)", () => {
    const scene = visScene([{ name: "front", boundMin: [-1, -1, 4], boundMax: [1, 1, 6] }]);
    let frameCb: ((deltaMs: number) => void) | undefined;
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = liteCollector({
      scene,
      camera: makeCamera({ pos: [0, 0, 0], forward: [0, 0, 1], fov: 0.8 }),
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      frameHook: (_s, cb) => {
        frameCb = cb;
      },
      capture: { ...offCapture, meshVisibility: true },
      meshVisibility: { windowMs: 5000, boundingBox: true },
    }).start(ctx);

    now.value = 1100;
    frameCb?.(100);
    vi.advanceTimersByTime(5000);

    const vis = events.filter((e) => e.type === "mesh_visibility");
    expect(vis).toHaveLength(1);
    // World-space AABB straight from boundMin/boundMax — no Z negation.
    expect((vis[0] as { bounds?: number[] }).bounds).toEqual([-1, -1, 4, 1, 1, 6]);
    handle.stop();
  });

  it("flushes an in-progress window on stop (#37)", () => {
    const scene = visScene([{ name: "front", boundMin: [-1, -1, 4], boundMax: [1, 1, 6] }]);
    let frameCb: ((deltaMs: number) => void) | undefined;
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const handle = liteCollector({
      scene,
      camera: makeCamera({ pos: [0, 0, 0], forward: [0, 0, 1], fov: 0.8 }),
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      frameHook: (_s, cb) => {
        frameCb = cb;
      },
      capture: { ...offCapture, meshVisibility: true },
      meshVisibility: { windowMs: 60_000 },
    }).start(ctx);

    now.value = 1100;
    frameCb?.(100);
    // No window timer has fired yet — stop() must emit the trailing summary.
    handle.stop();
    const vis = events.filter((e) => e.type === "mesh_visibility");
    expect(vis).toHaveLength(1);
    expect(vis[0]).toMatchObject({ mesh: "front", visibleMs: 100 });
  });
});

describe("liteCollector — hover_dwell (#48)", () => {
  const offCapture = {
    camera: false,
    perf: false,
    pointerMove: false,
    clicks: false,
    buttons: false,
    meshPicks: false,
    cameraGesture: false,
  };

  /** A mutable async picker — the hit can change between pointer events. */
  function mutablePicker(initial?: string): LitePickProbe & { set(mesh?: string): void } {
    let mesh = initial;
    return {
      pick: vi.fn(async () =>
        mesh ? { point: [0, 0, 0] as [number, number, number], mesh } : undefined,
      ),
      dispose: vi.fn(),
      set(next?: string) {
        mesh = next;
      },
    };
  }

  it("emits a hover_dwell summary when the pointer lingers then moves away (#48)", async () => {
    const canvas = makeCanvas();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const picker = mutablePicker("Cube");
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvas as unknown as HTMLCanvasElement,
      picker,
      pointerMoveThrottleMs: 0,
      capture: { ...offCapture, hoverDwell: true },
      hoverDwell: { minDwellMs: 500 },
    }).start(ctx);

    canvas.dispatch("pointermove", { clientX: 400, clientY: 300, pointerType: "mouse" });
    await flush();
    now.value = 1800;
    picker.set("Sphere");
    canvas.dispatch("pointermove", { clientX: 400, clientY: 300, pointerType: "mouse" });
    await flush();

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

  it("suppresses hover_dwell when the lingered object is clicked (#48)", async () => {
    const canvas = makeCanvas();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const picker = mutablePicker("Cube");
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvas as unknown as HTMLCanvasElement,
      picker,
      pointerMoveThrottleMs: 0,
      capture: { ...offCapture, hoverDwell: true },
      hoverDwell: { minDwellMs: 500 },
    }).start(ctx);

    canvas.dispatch("pointermove", { clientX: 400, clientY: 300, pointerType: "mouse" });
    await flush();
    now.value = 1800;
    // A click on the hovered object is deliberate engagement, not hesitation.
    canvas.dispatch("click", { clientX: 400, clientY: 300, button: 0, pointerType: "mouse" });
    await flush();
    now.value = 2000;
    picker.set(undefined);
    canvas.dispatch("pointermove", { clientX: 400, clientY: 300, pointerType: "mouse" });
    await flush();

    expect(events.some((e) => e.type === "hover_dwell")).toBe(false);
    handle.stop();
  });

  it("drops hover episodes shorter than minDwellMs (#48)", async () => {
    const canvas = makeCanvas();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const picker = mutablePicker("Cube");
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvas as unknown as HTMLCanvasElement,
      picker,
      pointerMoveThrottleMs: 0,
      capture: { ...offCapture, hoverDwell: true },
      hoverDwell: { minDwellMs: 500 },
    }).start(ctx);

    canvas.dispatch("pointermove", { clientX: 400, clientY: 300, pointerType: "mouse" });
    await flush();
    now.value = 1200; // only 200 ms < 500 ms threshold
    picker.set("Sphere");
    canvas.dispatch("pointermove", { clientX: 400, clientY: 300, pointerType: "mouse" });
    await flush();

    expect(events.some((e) => e.type === "hover_dwell")).toBe(false);
    handle.stop();
  });

  it("does not capture hover_dwell unless explicitly enabled (#48, ADR 0003)", async () => {
    const canvas = makeCanvas();
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const picker = mutablePicker("Cube");
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: canvas as unknown as HTMLCanvasElement,
      picker,
      pointerMoveThrottleMs: 0,
      capture: offCapture,
    }).start(ctx);

    // No hover listener is attached when neither pointerMove nor hoverDwell is on.
    expect(canvas.count("pointermove")).toBe(0);
    canvas.dispatch("pointermove", { clientX: 400, clientY: 300, pointerType: "mouse" });
    await flush();
    expect(events.some((e) => e.type === "hover_dwell")).toBe(false);
    handle.stop();
  });
});

describe("liteCollector — resource_sample (#44)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const offCapture = {
    camera: false,
    perf: false,
    pointerMove: false,
    clicks: false,
    buttons: false,
    meshPicks: false,
    cameraGesture: false,
  };

  it("does not sample resource footprint by default (opt-in)", () => {
    const { ctx, events } = makeCtx();
    const handle = liteCollector({
      scene: emptyScene,
      camera: makeCamera(),
      canvas: makeCanvas() as unknown as HTMLCanvasElement,
      capture: offCapture,
    }).start(ctx);

    vi.advanceTimersByTime(60_000);
    expect(events.some((e) => e.type === "resource_sample")).toBe(false);
    handle.stop();
  });

  it("emits a low-rate JS-heap footprint sample when enabled (#44)", () => {
    const perf = globalThis.performance as unknown as { memory?: unknown };
    const original = perf.memory;
    perf.memory = { usedJSHeapSize: 5_000_000 };
    try {
      const { ctx, events } = makeCtx();
      const handle = liteCollector({
        scene: emptyScene,
        camera: makeCamera(),
        canvas: makeCanvas() as unknown as HTMLCanvasElement,
        capture: { ...offCapture, resourceSample: true },
        resourceSample: { intervalMs: 1000 },
      }).start(ctx);

      vi.advanceTimersByTime(1000);
      const samples = events.filter((e) => e.type === "resource_sample");
      expect(samples).toHaveLength(1);
      expect(samples[0]).toMatchObject({ type: "resource_sample", jsHeapBytes: 5_000_000 });
      // Lite exposes no schema-mapped GPU counters — those metrics are omitted.
      expect(samples[0]).not.toHaveProperty("triangles");

      handle.stop();
      // Detached on stop — the timer no longer fires.
      vi.advanceTimersByTime(5000);
      expect(events.filter((e) => e.type === "resource_sample")).toHaveLength(1);
    } finally {
      perf.memory = original;
    }
  });

  it("emits nothing when no heap metric is measurable (#44)", () => {
    const perf = globalThis.performance as unknown as { memory?: unknown };
    const original = perf.memory;
    delete perf.memory;
    try {
      const { ctx, events } = makeCtx();
      const handle = liteCollector({
        scene: emptyScene,
        camera: makeCamera(),
        canvas: makeCanvas() as unknown as HTMLCanvasElement,
        capture: { ...offCapture, resourceSample: true },
        resourceSample: { intervalMs: 1000 },
      }).start(ctx);

      vi.advanceTimersByTime(1000);
      expect(events.some((e) => e.type === "resource_sample")).toBe(false);
      handle.stop();
    } finally {
      if (original !== undefined) perf.memory = original;
    }
  });
});
