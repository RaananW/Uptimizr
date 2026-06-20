import { afterEach, describe, expect, it, vi } from "vitest";
import { readGraphics, readGraphicsAsync } from "../graphics.js";

/** Install a structural `navigator` stub for the duration of one test. */
function stubNavigator(value: unknown): void {
  vi.stubGlobal("navigator", value);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readGraphics (sync)", () => {
  it("always reports the WebGPU/WGSL baseline with no backend", () => {
    const g = readGraphics();
    expect(g).toEqual({ api: "webgpu", shadingLanguage: "wgsl" });
    expect(g.backend).toBeUndefined();
  });
});

describe("readGraphicsAsync", () => {
  it("keeps the baseline when WebGPU is unavailable", async () => {
    stubNavigator({});
    const g = await readGraphicsAsync();
    expect(g).toEqual({ api: "webgpu", shadingLanguage: "wgsl" });
  });

  it("keeps the baseline when no adapter is returned", async () => {
    stubNavigator({ gpu: { requestAdapter: () => Promise.resolve(null) } });
    const g = await readGraphicsAsync();
    expect(g.backend).toBeUndefined();
  });

  it("resolves the backend from the adapter info architecture string (sync getter)", async () => {
    stubNavigator({
      gpu: {
        requestAdapter: () => Promise.resolve({ info: { architecture: "metal-3" } }),
      },
    });
    const g = await readGraphicsAsync();
    expect(g.backend).toBe("metal");
    expect(g.api).toBe("webgpu");
  });

  it("maps a D3D12 description to the d3d12 backend", async () => {
    stubNavigator({
      gpu: {
        requestAdapter: () =>
          Promise.resolve({ info: { description: "D3D12 (NVIDIA GeForce RTX)" } }),
      },
    });
    expect((await readGraphicsAsync()).backend).toBe("d3d12");
  });

  it("falls back to the platform when the adapter info names no driver", async () => {
    stubNavigator({
      platform: "Win32",
      gpu: { requestAdapter: () => Promise.resolve({ info: { vendor: "intel" } }) },
    });
    expect((await readGraphicsAsync()).backend).toBe("d3d12");
  });

  it("supports the deprecated async requestAdapterInfo() shape", async () => {
    stubNavigator({
      gpu: {
        requestAdapter: () =>
          Promise.resolve({
            requestAdapterInfo: () => Promise.resolve({ architecture: "vulkan" }),
          }),
      },
    });
    expect((await readGraphicsAsync()).backend).toBe("vulkan");
  });

  it("keeps the baseline when requestAdapter throws", async () => {
    stubNavigator({
      gpu: {
        requestAdapter: () => Promise.reject(new Error("no gpu")),
      },
    });
    const g = await readGraphicsAsync();
    expect(g).toEqual({ api: "webgpu", shadingLanguage: "wgsl" });
  });
});
