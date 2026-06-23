import { describe, expect, it, vi } from "vitest";
import type { PanelContext, PanelDataContext } from "@uptimizr/react";
import { builtinPanels } from "../registry";

/** Minimal context stub for exercising a panel's `enabled` predicate. */
function ctxWithCameraMode(cameraMode: "viewer" | "first-person" | undefined): PanelContext {
  return { filters: { window: "24h", cameraMode } } as unknown as PanelContext;
}

describe("builtinPanels — floor-plan panel", () => {
  const panel = builtinPanels.find((p) => p.id === "floor-plan");

  it("is registered with the expected metadata", () => {
    expect(panel).toBeDefined();
    expect(panel?.span).toBe(1);
    expect(panel?.clientOnly).toBe(true);
    expect(panel?.surfaces).toEqual(["overview", "session"]);
  });

  it("is hidden in the orbit/viewer camera mode and shown otherwise", () => {
    expect(panel?.enabled?.(ctxWithCameraMode("viewer"))).toBe(false);
    expect(panel?.enabled?.(ctxWithCameraMode("first-person"))).toBe(true);
    expect(panel?.enabled?.(ctxWithCameraMode(undefined))).toBe(true);
  });
});

/** Build a load-context stub with stubbed collector methods for the world panel. */
function loadCtx(opts: {
  scene?: string;
  voxels?: unknown[];
  scenes?: { scene_id: string }[];
  proxyMeshes?: { name: string }[];
}): {
  ctx: PanelDataContext;
  worldHeatmap: ReturnType<typeof vi.fn>;
  scenes: ReturnType<typeof vi.fn>;
  sceneRepresentation: ReturnType<typeof vi.fn>;
} {
  const worldHeatmap = vi.fn().mockResolvedValue(opts.voxels ?? []);
  const scenes = vi.fn().mockResolvedValue(opts.scenes ?? []);
  const sceneRepresentation = vi
    .fn()
    .mockResolvedValue({ proxy: { meshes: opts.proxyMeshes ?? [] } });
  const ctx = {
    surface: "overview",
    params: opts.scene ? { scene: opts.scene } : {},
    api: { worldHeatmap, scenes, sceneRepresentation },
  } as unknown as PanelDataContext;
  return { ctx, worldHeatmap, scenes, sceneRepresentation };
}

describe("builtinPanels — world-heatmap panel", () => {
  const panel = builtinPanels.find((p) => p.id === "world-heatmap-3d");

  it("is registered as a full-width, client-only panel on both surfaces", () => {
    expect(panel).toBeDefined();
    expect(panel?.span).toBe(2);
    expect(panel?.clientOnly).toBe(true);
    expect(panel?.surfaces).toEqual(["overview", "session"]);
    // Always visible — no camera-mode gate, unlike the floor plan.
    expect(panel?.enabled).toBeUndefined();
  });

  it("loads voxels and resolves the proxy backdrop from the selected scene", async () => {
    const { ctx, sceneRepresentation, scenes } = loadCtx({
      scene: "scene-a",
      voxels: [{ vx: 0, vy: 0, vz: 0, count: 3 }],
      proxyMeshes: [{ name: "Floor" }],
    });
    const data = (await panel?.load?.(ctx)) as { voxels: unknown[]; proxyMeshes: unknown[] };
    expect(data.voxels).toHaveLength(1);
    expect(data.proxyMeshes).toEqual([{ name: "Floor" }]);
    expect(sceneRepresentation).toHaveBeenCalledWith("scene-a");
    // A selected scene short-circuits the scene-list lookup.
    expect(scenes).not.toHaveBeenCalled();
  });

  it("falls back to the sole scene when none is selected", async () => {
    const { ctx, sceneRepresentation } = loadCtx({
      scenes: [{ scene_id: "only-scene" }],
      proxyMeshes: [{ name: "Wall" }],
    });
    const data = (await panel?.load?.(ctx)) as { proxyMeshes: unknown[] };
    expect(sceneRepresentation).toHaveBeenCalledWith("only-scene");
    expect(data.proxyMeshes).toEqual([{ name: "Wall" }]);
  });

  it("draws no backdrop when the scene is ambiguous", async () => {
    const { ctx, sceneRepresentation } = loadCtx({
      scenes: [{ scene_id: "a" }, { scene_id: "b" }],
    });
    const data = (await panel?.load?.(ctx)) as { proxyMeshes: unknown[] };
    expect(sceneRepresentation).not.toHaveBeenCalled();
    expect(data.proxyMeshes).toEqual([]);
  });
});
