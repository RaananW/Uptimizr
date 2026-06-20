import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Camera, Scene, WebGLRenderer } from "three";
import { trackScene } from "../trackScene.js";

function makeCanvas() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  return {
    listeners,
    addEventListener(type: string, h: (e: unknown) => void) {
      (listeners[type] ??= []).push(h);
    },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    count(type: string) {
      return (listeners[type] ?? []).length;
    },
  };
}

function makeCamera(): Camera {
  return {
    isPerspectiveCamera: true,
    name: "main",
    fov: 60,
    getWorldPosition(t: { set(x: number, y: number, z: number): unknown }) {
      t.set(1, 2, 3);
      return t;
    },
    getWorldDirection(t: { set(x: number, y: number, z: number): unknown }) {
      t.set(0, 0, -1);
      return t;
    },
  } as unknown as Camera;
}

function makeScene(): Scene {
  return {
    traverse(cb: (o: { isMesh?: boolean }) => void) {
      cb({ isMesh: true });
    },
  } as unknown as Scene;
}

function makeRenderer(canvas: ReturnType<typeof makeCanvas>): WebGLRenderer {
  return {
    domElement: canvas,
    info: { render: { frame: 0 } },
    capabilities: { isWebGL2: true, maxTextureSize: 8192 },
    getContext: () => ({
      VENDOR: 1,
      RENDERER: 2,
      VERSION: 3,
      getExtension: () => null,
      getParameter: () => "x",
    }),
  } as unknown as WebGLRenderer;
}

describe("trackScene", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts a session and wires the three collector in one call", () => {
    const canvas = makeCanvas();

    const client = trackScene(makeScene(), makeCamera(), makeRenderer(canvas), {
      projectId: "proj_demo",
      endpoint: "http://localhost:4318",
      flushIntervalMs: 0,
    });

    expect(typeof client.sessionId).toBe("string");
    expect(client.sessionId.length).toBeGreaterThan(0);
    expect(client.config.projectId).toBe("proj_demo");

    // The collector registered its pointer listener, i.e. capture is live.
    expect(canvas.count("pointermove")).toBeGreaterThan(0);
  });

  it("respects disabled (no capture wired)", () => {
    const canvas = makeCanvas();

    trackScene(makeScene(), makeCamera(), makeRenderer(canvas), {
      projectId: "proj_demo",
      endpoint: "http://localhost:4318",
      disabled: true,
    });

    // start() is a no-op when disabled, so no listener is registered.
    expect(canvas.count("pointermove")).toBe(0);
  });
});
