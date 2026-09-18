import { describe, expect, it } from "vitest";

import type { CollectorApi, SceneProxyMesh } from "../../../api";
import { mergeSceneProxies, proxyMeshKey } from "../sceneProxies";

// `mergeSceneProxies` only touches two api methods, so a duck-typed stub is enough.
function fakeApi(reps: Record<string, SceneProxyMesh[]>): CollectorApi {
  return {
    scenes: async () => Object.keys(reps).map((scene_id) => ({ scene_id })),
    sceneRepresentation: async (sceneId: string) => ({ proxy: { meshes: reps[sceneId] ?? [] } }),
  } as unknown as CollectorApi;
}

describe("proxyMeshKey", () => {
  it("keys named meshes by name so a bridging mesh in two areas dedups", () => {
    const a: SceneProxyMesh = { name: "ramp", aabb: [0, 0, 0, 1, 1, 1] };
    const b: SceneProxyMesh = { name: "ramp", aabb: [5, 5, 5, 6, 6, 6] };
    expect(proxyMeshKey(a)).toBe(proxyMeshKey(b));
  });

  it("gives unnamed meshes distinct keys by geometry", () => {
    const wallN: SceneProxyMesh = { name: "", aabb: [-28, 0, 27.5, 28, 6, 28.5] };
    const wallS: SceneProxyMesh = { name: "", aabb: [-28, 0, -28.5, 28, 6, -27.5] };
    expect(proxyMeshKey(wallN)).not.toBe(proxyMeshKey(wallS));
    // The same unnamed mesh registered twice still collapses.
    expect(proxyMeshKey(wallN)).toBe(proxyMeshKey({ ...wallN }));
    // And an unnamed key can never collide with a real name.
    expect(proxyMeshKey(wallN)).not.toBe(
      proxyMeshKey({ name: wallN.aabb.join(","), aabb: wallN.aabb }),
    );
  });
});

describe("mergeSceneProxies", () => {
  it("keeps every unnamed mesh instead of collapsing them into one", async () => {
    const meshes: SceneProxyMesh[] = [
      { name: "ground", aabb: [-28, 0, -28, 28, 0, 28] },
      { name: "", aabb: [-28, 0, 27.5, 28, 6, 28.5] },
      { name: "", aabb: [-28, 0, -28.5, 28, 6, -27.5] },
      { name: "", aabb: [-8.5, 0, -5, -7.5, 6, 17] },
    ];
    const merged = await mergeSceneProxies(fakeApi({ atrium: meshes }));
    expect(merged).toHaveLength(4);
  });

  it("dedups a named mesh registered in two areas and drops nothing else", async () => {
    const merged = await mergeSceneProxies(
      fakeApi({
        overview: [
          { name: "ground", aabb: [0, 0, 0, 100, 0, 100] },
          { name: "ramp", aabb: [10, 0, 10, 20, 5, 20] },
        ],
        overlook: [
          { name: "ramp", aabb: [10, 0, 10, 20, 5, 20] },
          { name: "crate", aabb: [30, 5, 30, 31, 6, 31] },
        ],
      }),
    );
    expect(merged.map((m) => m.name)).toEqual(["ground", "ramp", "crate"]);
  });
});
