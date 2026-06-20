import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scene } from "@babylonjs/core";
import { trackScene } from "../trackScene.js";

class FakeObservable<T> {
  observers: Array<(e: T) => void> = [];
  add(cb: (e: T) => void) {
    this.observers.push(cb);
    return cb as unknown as never;
  }
  remove() {
    return true;
  }
}

function makeScene() {
  const onPointerObservable = new FakeObservable<unknown>();
  const engine = {
    getFps: () => 60,
    getRenderWidth: () => 800,
    getRenderHeight: () => 600,
    isWebGPU: false,
    webGLVersion: 2,
    getGlInfo: () => ({ vendor: "Acme", renderer: "GPU-9000" }),
    getCaps: () => ({ maxTextureSize: 8192 }),
  };
  const scene = {
    activeCamera: {
      globalPosition: { x: 1, y: 2, z: 3 },
      getForwardRay: () => ({ direction: { x: 0, y: 0, z: 1 } }),
      fov: 0.8,
      getTarget: () => ({ x: 0, y: 0, z: 0 }),
    },
    pointerX: 400,
    pointerY: 300,
    onPointerObservable,
    getEngine: () => engine,
  };
  return { scene: scene as unknown as Scene, onPointerObservable };
}

describe("trackScene", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts a session and wires the Babylon collector in one call", () => {
    const { scene, onPointerObservable } = makeScene();

    const client = trackScene(scene, {
      projectId: "proj_demo",
      endpoint: "http://localhost:4318",
      flushIntervalMs: 0,
    });

    // Returns a started client with an in-memory session id.
    expect(typeof client.sessionId).toBe("string");
    expect(client.sessionId.length).toBeGreaterThan(0);
    expect(client.config.projectId).toBe("proj_demo");

    // The collector registered its pointer observer, i.e. capture is live.
    expect(onPointerObservable.observers.length).toBeGreaterThan(0);
  });

  it("respects disabled (no capture wired)", () => {
    const { scene, onPointerObservable } = makeScene();

    trackScene(scene, {
      projectId: "proj_demo",
      endpoint: "http://localhost:4318",
      disabled: true,
    });

    // start() is a no-op when disabled, so no observer is registered.
    expect(onPointerObservable.observers.length).toBe(0);
  });
});
