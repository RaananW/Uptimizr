import { describe, expect, it } from "vitest";
import type { WebGLRenderer } from "three";
import { readGraphics } from "../graphics.js";

interface FakeRendererOpts {
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

function fakeRenderer(opts: FakeRendererOpts = {}): WebGLRenderer {
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
    isWebGPURenderer: opts.webgpu ?? false,
    capabilities: { isWebGL2: opts.isWebGL2 ?? true, maxTextureSize: 8192 },
    getContext: () => (opts.webgpu ? undefined : gl),
  } as unknown as WebGLRenderer;
}

describe("readGraphics", () => {
  it("maps a WebGL2 renderer to the webgl2 api with glsl-es", () => {
    const g = readGraphics(fakeRenderer({ isWebGL2: true }));
    expect(g.api).toBe("webgl2");
    expect(g.shadingLanguage).toBe("glsl-es");
  });

  it("maps a WebGPU renderer to the webgpu api with wgsl", () => {
    const g = readGraphics(fakeRenderer({ webgpu: true }));
    expect(g.api).toBe("webgpu");
    expect(g.shadingLanguage).toBe("wgsl");
    // WebGPU's real backend isn't exposed by three — leave it unset.
    expect(g.backend).toBeUndefined();
  });

  it("infers the real backend from an unmasked ANGLE renderer string", () => {
    expect(
      readGraphics(fakeRenderer({ unmasked: true, renderer: "ANGLE (NVIDIA, Direct3D11)" }))
        .backend,
    ).toBe("d3d11");
    expect(
      readGraphics(
        fakeRenderer({ unmasked: true, renderer: "ANGLE (Apple, ANGLE Metal Renderer)" }),
      ).backend,
    ).toBe("metal");
    expect(
      readGraphics(fakeRenderer({ unmasked: true, renderer: "ANGLE (Intel, Vulkan 1.3)" })).backend,
    ).toBe("vulkan");
  });

  it("records the API version when exposed and omits backend when unknown", () => {
    const g = readGraphics(fakeRenderer({ version: "WebGL 2.0", renderer: "Some GPU" }));
    expect(g.apiVersion).toBe("WebGL 2.0");
    expect(g.backend).toBeUndefined();
  });
});
