import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBase, Entity } from "playcanvas";
import { PROJECTION_PERSPECTIVE } from "playcanvas";
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

function makeCamera(): Entity {
  return {
    name: "main",
    getPosition: () => ({ x: 1, y: 2, z: 3 }),
    forward: { x: 0, y: 0, z: -1 },
    camera: { projection: PROJECTION_PERSPECTIVE, fov: 60 },
  } as unknown as Entity;
}

function makeApp(canvas: ReturnType<typeof makeCanvas>): AppBase {
  const gl = {
    VENDOR: 1,
    RENDERER: 2,
    VERSION: 3,
    getExtension: () => null,
    getParameter: () => "x",
  };
  return {
    graphicsDevice: { canvas, isWebGPU: false, isWebGL2: true, maxTextureSize: 8192, gl },
    stats: { frame: { fps: 60, triangles: 0 } },
    root: {
      forEach(cb: (n: unknown) => void) {
        cb({ render: { meshInstances: [{}] } });
      },
    },
    on() {},
    off() {},
  } as unknown as AppBase;
}

describe("trackScene", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts a session and wires the PlayCanvas collector in one call", () => {
    const canvas = makeCanvas();

    const client = trackScene(makeApp(canvas), makeCamera(), {
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

    trackScene(makeApp(canvas), makeCamera(), {
      projectId: "proj_demo",
      endpoint: "http://localhost:4318",
      disabled: true,
    });

    // start() is a no-op when disabled, so no listener is registered.
    expect(canvas.count("pointermove")).toBe(0);
  });
});
