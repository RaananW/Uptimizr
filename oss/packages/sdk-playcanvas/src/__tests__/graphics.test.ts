import { describe, expect, it } from "vitest";
import type { AppBase } from "playcanvas";
import { readGraphics } from "../graphics.js";

interface FakeDeviceOpts {
  webgpu?: boolean;
  isWebGL2?: boolean;
  vendor?: string;
  renderer?: string;
  version?: string;
  unmasked?: boolean;
}

const VENDOR = 0x1f00;
const RENDERER = 0x1f01;
const VERSION = 0x1f02;
const UNMASKED_VENDOR = 0x9245;
const UNMASKED_RENDERER = 0x9246;

/** Build a PlayCanvas app whose `graphicsDevice` mimics a WebGL/WebGPU device. */
function fakeApp(opts: FakeDeviceOpts = {}): AppBase {
  const gl = {
    VENDOR,
    RENDERER,
    VERSION,
    getExtension: (name: string) =>
      opts.unmasked && name === "WEBGL_debug_renderer_info"
        ? { UNMASKED_VENDOR_WEBGL: UNMASKED_VENDOR, UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER }
        : null,
    getParameter: (p: number) => {
      if (p === UNMASKED_VENDOR || p === VENDOR) return opts.vendor;
      if (p === UNMASKED_RENDERER || p === RENDERER) return opts.renderer;
      if (p === VERSION) return opts.version;
      return undefined;
    },
  };
  return {
    graphicsDevice: {
      isWebGPU: opts.webgpu ?? false,
      isWebGL2: opts.isWebGL2 ?? true,
      maxTextureSize: 8192,
      gl: opts.webgpu ? undefined : gl,
    },
  } as unknown as AppBase;
}

describe("readGraphics", () => {
  it("maps a WebGL2 device to the webgl2 api with glsl-es", () => {
    const g = readGraphics(fakeApp({ isWebGL2: true }));
    expect(g.api).toBe("webgl2");
    expect(g.shadingLanguage).toBe("glsl-es");
  });

  it("maps a WebGPU device to the webgpu api with wgsl", () => {
    const g = readGraphics(fakeApp({ webgpu: true }));
    expect(g.api).toBe("webgpu");
    expect(g.shadingLanguage).toBe("wgsl");
    // WebGPU's real backend isn't exposed by PlayCanvas — leave it unset.
    expect(g.backend).toBeUndefined();
  });

  it("infers the real backend from an unmasked ANGLE renderer string", () => {
    expect(
      readGraphics(fakeApp({ unmasked: true, renderer: "ANGLE (NVIDIA, Direct3D11)" })).backend,
    ).toBe("d3d11");
    expect(
      readGraphics(fakeApp({ unmasked: true, renderer: "ANGLE (Apple, ANGLE Metal Renderer)" }))
        .backend,
    ).toBe("metal");
    expect(
      readGraphics(fakeApp({ unmasked: true, renderer: "ANGLE (Intel, Vulkan 1.3)" })).backend,
    ).toBe("vulkan");
  });

  it("records the API version when exposed and omits backend when unknown", () => {
    const g = readGraphics(fakeApp({ version: "WebGL 2.0", renderer: "Some GPU" }));
    expect(g.apiVersion).toBe("WebGL 2.0");
    expect(g.backend).toBeUndefined();
  });
});
