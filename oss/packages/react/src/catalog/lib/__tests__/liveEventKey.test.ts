import { describe, expect, it } from "vitest";
import { liveEventKey } from "../liveEventKey";

describe("liveEventKey", () => {
  it("tells apart the events one click emits in the same millisecond", () => {
    const ts = 1_000;
    const keys = new Set(
      [
        { type: "pointer_down", ts, hitMesh: "wall-s" },
        { type: "pointer_up", ts, hitMesh: "wall-s" },
        { type: "pointer_click", ts, hitMesh: "wall-s" },
        { type: "mesh_interaction", ts, mesh: "wall-s" },
      ].map(liveEventKey),
    );
    expect(keys.size).toBe(4);
  });

  it("tells apart actors and their children sampled in the same millisecond", () => {
    const ts = 2_000;
    const keys = new Set(
      [
        { type: "node_transform", ts, nodeId: "npc" },
        { type: "node_transform", ts, nodeId: "npc", childPath: "arm" },
        { type: "node_transform", ts, nodeId: "door" },
      ].map(liveEventKey),
    );
    expect(keys.size).toBe(3);
  });

  it("matches the same event loaded twice (backfill overlap)", () => {
    const a = { type: "pointer_click", ts: 3_000, hitMesh: "box-1", screen: [0.5, 0.5] };
    const b = { type: "pointer_click", ts: 3_000, hitMesh: "box-1", projectId: "demo" };
    expect(liveEventKey(a)).toBe(liveEventKey(b));
  });
});
