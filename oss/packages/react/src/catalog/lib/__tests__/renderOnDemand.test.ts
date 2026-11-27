import { describe, expect, it } from "vitest";
import { ACTIVE_FRAMES, IDLE_RENDER_MS, renderOnDemand } from "../renderOnDemand";

class FakeObservable {
  observers = new Set<() => void>();
  add(cb: () => void) {
    this.observers.add(cb);
    return cb;
  }
  remove(o: unknown) {
    this.observers.delete(o as () => void);
  }
  fire() {
    for (const cb of this.observers) cb();
  }
}

/** A Babylon engine + scene stand-in driven one animation frame at a time. */
function setup() {
  let loop: (() => void) | null = null;
  const clock = { t: 0 };
  const engine = {
    runRenderLoop: (cb: () => void) => {
      loop = cb;
    },
    stopRenderLoop: () => {
      loop = null;
    },
    onResizeObservable: new FakeObservable(),
  };
  const scene = {
    renders: 0,
    ready: true,
    render() {
      this.renders += 1;
    },
    isReady() {
      return this.ready;
    },
    activeCamera: { onViewMatrixChangedObservable: new FakeObservable() },
    onPointerObservable: new FakeObservable(),
    onNewMeshAddedObservable: new FakeObservable(),
    onMeshRemovedObservable: new FakeObservable(),
    onNewMaterialAddedObservable: new FakeObservable(),
  };
  const listeners = new Map<string, () => void>();
  const panel = {
    addEventListener: (type: string, cb: () => void) => listeners.set(type, cb),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as HTMLElement;
  /** Run `n` frames 16 ms apart. */
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.t += 16;
      loop?.();
    }
  };
  const handle = renderOnDemand(engine, scene, panel, () => clock.t);
  return { engine, scene, listeners, frames, handle, running: () => loop !== null };
}

describe("renderOnDemand", () => {
  it("renders a new scene for a moment, then stops while nothing changes", () => {
    const { scene, frames } = setup();
    frames(ACTIVE_FRAMES);
    expect(scene.renders).toBe(ACTIVE_FRAMES);
    frames(20); // 320 ms idle: under the idle heartbeat
    expect(scene.renders).toBe(ACTIVE_FRAMES);
  });

  it("still renders an idle scene twice a second", () => {
    const { scene, frames } = setup();
    frames(ACTIVE_FRAMES);
    const before = scene.renders;
    frames(Math.ceil(2_000 / 16)); // 2 s idle
    const idle = scene.renders - before;
    expect(idle).toBeGreaterThanOrEqual(2_000 / IDLE_RENDER_MS - 1);
    expect(idle).toBeLessThanOrEqual(2_000 / IDLE_RENDER_MS + 1);
  });

  it("keeps rendering while the scene is not ready (shaders compiling)", () => {
    const { scene, frames } = setup();
    frames(ACTIVE_FRAMES);
    scene.ready = false;
    const before = scene.renders;
    frames(10);
    expect(scene.renders - before).toBe(10);
  });

  it.each([
    [
      "a camera move",
      (s: ReturnType<typeof setup>) => s.scene.activeCamera.onViewMatrixChangedObservable.fire(),
    ],
    [
      "a pointer event on the scene",
      (s: ReturnType<typeof setup>) => s.scene.onPointerObservable.fire(),
    ],
    ["a mesh added", (s: ReturnType<typeof setup>) => s.scene.onNewMeshAddedObservable.fire()],
    ["a resize", (s: ReturnType<typeof setup>) => s.engine.onResizeObservable.fire()],
    [
      "a click on the panel's HTML controls",
      (s: ReturnType<typeof setup>) => s.listeners.get("pointerdown")?.(),
    ],
    ["a key press", (s: ReturnType<typeof setup>) => s.listeners.get("keydown")?.()],
    ["a data repaint", (s: ReturnType<typeof setup>) => s.handle.invalidate()],
  ])("renders again after %s", (_label, trigger) => {
    const s = setup();
    s.frames(ACTIVE_FRAMES + 10);
    const before = s.scene.renders;
    trigger(s);
    s.frames(ACTIVE_FRAMES + 10);
    expect(s.scene.renders - before).toBe(ACTIVE_FRAMES);
  });

  it("stops the loop and detaches every listener on dispose", () => {
    const s = setup();
    s.handle.dispose();
    expect(s.running()).toBe(false);
    expect(s.listeners.size).toBe(0);
    expect(s.scene.onPointerObservable.observers.size).toBe(0);
    expect(s.scene.activeCamera.onViewMatrixChangedObservable.observers.size).toBe(0);
  });
});
