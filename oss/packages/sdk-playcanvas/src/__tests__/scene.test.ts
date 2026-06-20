import { describe, expect, it } from "vitest";
import type { AppBase, Entity } from "playcanvas";
import { PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE } from "playcanvas";
import { classifyCamera, readSceneMeta } from "../scene.js";
import { readDeviceCaps } from "../device.js";

/** A PlayCanvas app whose root walk yields `meshCount` renderable nodes + a light. */
function fakeApp(meshCount: number): AppBase {
  return {
    root: {
      forEach(cb: (n: unknown) => void) {
        for (let i = 0; i < meshCount; i++) cb({ render: { meshInstances: [{}] } });
        cb({ light: {} }); // a non-renderable node (light/group) is not counted
      },
    },
  } as unknown as AppBase;
}

function cameraWith(projection: number, name?: string): Entity {
  return { name, camera: { projection } } as unknown as Entity;
}

describe("classifyCamera", () => {
  it("maps a perspective camera to free and an orthographic camera to static", () => {
    expect(classifyCamera(cameraWith(PROJECTION_PERSPECTIVE))).toBe("free");
    expect(classifyCamera(cameraWith(PROJECTION_ORTHOGRAPHIC))).toBe("static");
  });

  it("falls back to other for anything else", () => {
    expect(classifyCamera({ camera: {} } as unknown as Entity)).toBe("other");
    expect(classifyCamera(null)).toBe("other");
  });
});

describe("readSceneMeta", () => {
  it("reads the camera kind/name and counts mesh instances by traversal", () => {
    const camera = cameraWith(PROJECTION_PERSPECTIVE, "mainCamera");
    const meta = readSceneMeta(fakeApp(3), camera);
    expect(meta.cameraType).toBe("free");
    expect(meta.cameraName).toBe("mainCamera");
    expect(meta.meshCount).toBe(3);
  });
});

describe("readDeviceCaps", () => {
  it("maps a WebGL2 device's caps into the schema device block", () => {
    const gl = {
      VENDOR: 1,
      RENDERER: 2,
      VERSION: 3,
      getExtension: () => null,
      getParameter: (p: number) => (p === 1 ? "Acme" : p === 2 ? "GPU-9000" : "WebGL 2.0"),
    };
    const app = {
      graphicsDevice: { isWebGPU: false, isWebGL2: true, maxTextureSize: 8192, gl },
    } as unknown as AppBase;

    const device = readDeviceCaps(app);
    expect(device.engine).toBe("webgl2");
    expect(device.vendor).toBe("Acme");
    expect(device.renderer).toBe("GPU-9000");
    expect(device.maxTextureSize).toBe(8192);
  });
});
