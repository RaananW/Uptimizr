import { describe, expect, it } from "vitest";
import type { Scene } from "@babylonjs/core";
import { readGraphics } from "../graphics.js";

interface FakeEngineOpts {
  isWebGPU?: boolean;
  webGLVersion?: number;
  renderer?: string;
  version?: string;
}

function fakeScene(opts: FakeEngineOpts = {}): Scene {
  const engine = {
    isWebGPU: opts.isWebGPU ?? false,
    webGLVersion: opts.webGLVersion,
    getGlInfo: () => ({ renderer: opts.renderer, version: opts.version }),
  };
  return { getEngine: () => engine } as unknown as Scene;
}

describe("readGraphics", () => {
  it("maps a WebGL2 engine to the webgl2 api with glsl-es", () => {
    const g = readGraphics(fakeScene({ webGLVersion: 2 }));
    expect(g.api).toBe("webgl2");
    expect(g.shadingLanguage).toBe("glsl-es");
  });

  it("maps a WebGPU engine to the webgpu api with wgsl", () => {
    const g = readGraphics(fakeScene({ isWebGPU: true }));
    expect(g.api).toBe("webgpu");
    expect(g.shadingLanguage).toBe("wgsl");
    // WebGPU's real backend isn't exposed by Babylon — leave it unset.
    expect(g.backend).toBeUndefined();
  });

  it("infers the real backend from an ANGLE renderer string", () => {
    expect(
      readGraphics(fakeScene({ webGLVersion: 2, renderer: "ANGLE (NVIDIA, Direct3D11)" })).backend,
    ).toBe("d3d11");
    expect(
      readGraphics(fakeScene({ webGLVersion: 2, renderer: "ANGLE (Apple, ANGLE Metal Renderer)" }))
        .backend,
    ).toBe("metal");
    expect(
      readGraphics(fakeScene({ webGLVersion: 2, renderer: "ANGLE (Intel, Vulkan 1.3)" })).backend,
    ).toBe("vulkan");
  });

  it("records the API version when exposed and omits backend when unknown", () => {
    const g = readGraphics(
      fakeScene({ webGLVersion: 2, version: "WebGL 2.0", renderer: "Some GPU" }),
    );
    expect(g.apiVersion).toBe("WebGL 2.0");
    expect(g.backend).toBeUndefined();
  });

  it("falls back to unknown for an unrecognized engine", () => {
    const g = readGraphics(fakeScene({}));
    expect(g.api).toBe("unknown");
    expect(g.shadingLanguage).toBe("unknown");
  });
});
