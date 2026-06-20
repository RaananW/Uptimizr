import { describe, expect, it } from "vitest";
import { LIMITS, SCENE_PROXY_VERSION, sceneProxySchema, type SceneProxy } from "../index.js";

function validProxy(overrides: Partial<SceneProxy> = {}): SceneProxy {
  return {
    version: SCENE_PROXY_VERSION,
    sceneId: "lobby",
    kind: "aabb",
    bounds: [-2, 0, -2, 2, 3, 2],
    upAxis: "y",
    unitScale: 1,
    meshes: [{ name: "floor", aabb: [-2, 0, -2, 2, 0.1, 2], triangles: 2 }],
    meshCount: 1,
    contentHash: "abc123",
    capturedAt: 1_750_000_000_000,
    sdkVersion: "0.1.0",
    ...overrides,
  };
}

describe("sceneProxySchema", () => {
  it("accepts a well-formed proxy", () => {
    expect(sceneProxySchema.parse(validProxy())).toMatchObject({ sceneId: "lobby", kind: "aabb" });
  });

  it("requires a 6-tuple AABB", () => {
    expect(() => sceneProxySchema.parse(validProxy({ bounds: [0, 0, 0] as never }))).toThrow();
  });

  it("rejects a non-positive unitScale", () => {
    expect(() => sceneProxySchema.parse(validProxy({ unitScale: 0 }))).toThrow();
  });

  it("rejects a PII-ish high-cardinality sceneId", () => {
    expect(() => sceneProxySchema.parse(validProxy({ sceneId: "user@example.com" }))).toThrow();
  });

  it("rejects an unknown proxy kind", () => {
    expect(() => sceneProxySchema.parse(validProxy({ kind: "voxel" as never }))).toThrow();
  });

  it("rejects a proxy carrying more meshes than the cap (#3)", () => {
    const meshes = Array.from({ length: LIMITS.maxSceneProxyMeshes + 1 }, () => ({
      name: "m",
      aabb: [0, 0, 0, 1, 1, 1] as const,
    }));
    expect(() => sceneProxySchema.parse(validProxy({ meshes }))).toThrow();
  });

  it("rejects an over-length mesh name (#3)", () => {
    expect(() =>
      sceneProxySchema.parse(
        validProxy({
          meshes: [
            { name: "m".repeat(LIMITS.maxSceneProxyMeshNameLength + 1), aabb: [0, 0, 0, 1, 1, 1] },
          ],
        }),
      ),
    ).toThrow();
  });
});
