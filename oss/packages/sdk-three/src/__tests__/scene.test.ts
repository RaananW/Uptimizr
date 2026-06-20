import { describe, expect, it } from "vitest";
import type { Camera, Scene } from "three";
import { classifyCamera, readSceneMeta } from "../scene.js";
import { readDeviceCaps } from "../device.js";

function fakeScene(meshCount: number): Scene {
  return {
    traverse(cb: (o: { isMesh?: boolean }) => void) {
      for (let i = 0; i < meshCount; i++) cb({ isMesh: true });
      cb({ isMesh: false }); // a non-mesh node (light/group) is not counted
    },
  } as unknown as Scene;
}

describe("classifyCamera", () => {
  it("maps a PerspectiveCamera to free and an OrthographicCamera to static", () => {
    expect(classifyCamera({ isPerspectiveCamera: true } as unknown as Camera)).toBe("free");
    expect(classifyCamera({ isOrthographicCamera: true } as unknown as Camera)).toBe("static");
  });

  it("falls back to other for anything else", () => {
    expect(classifyCamera({} as unknown as Camera)).toBe("other");
    expect(classifyCamera(null)).toBe("other");
  });
});

describe("readSceneMeta", () => {
  it("reads the camera kind/name and counts meshes by traversal", () => {
    const camera = { isPerspectiveCamera: true, name: "mainCamera" } as unknown as Camera;
    const meta = readSceneMeta(fakeScene(3), camera);
    expect(meta.cameraType).toBe("free");
    expect(meta.cameraName).toBe("mainCamera");
    expect(meta.meshCount).toBe(3);
  });
});

describe("readDeviceCaps", () => {
  it("maps a WebGL2 renderer's caps into the schema device block", () => {
    const gl = {
      VENDOR: 1,
      RENDERER: 2,
      VERSION: 3,
      getExtension: () => null,
      getParameter: (p: number) => (p === 1 ? "Acme" : p === 2 ? "GPU-9000" : "WebGL 2.0"),
    };
    const renderer = {
      isWebGPURenderer: false,
      capabilities: { isWebGL2: true, maxTextureSize: 8192 },
      getContext: () => gl,
    } as unknown as Parameters<typeof readDeviceCaps>[0];

    const device = readDeviceCaps(renderer);
    expect(device.engine).toBe("webgl2");
    expect(device.vendor).toBe("Acme");
    expect(device.renderer).toBe("GPU-9000");
    expect(device.maxTextureSize).toBe(8192);
  });
});
