"use client";

import { definePanel, type PanelContext, type PanelDefinition } from "@uptimizr/react";
import type { DirectionBin, HeatmapBin, MeshCount, PositionBin, QueryParams } from "@/lib/api";
import {
  CameraDome3DView,
  CAMERA_DOME_TITLE,
  CAMERA_DOME_SUBTITLE,
} from "@/components/CameraDome3D";
import {
  FloorPlanHeatmapView,
  FLOOR_PLAN_TITLE,
  FLOOR_PLAN_SUBTITLE,
  FLOOR_PLAN_HELP,
} from "@/components/FloorPlanHeatmap";
import {
  PointerHeatmapView,
  POINTER_HEATMAP_TITLE,
  POINTER_HEATMAP_SUBTITLE,
} from "@/components/PointerHeatmap";
import { TopMeshesView, TOP_MESHES_TITLE, TOP_MESHES_SUBTITLE } from "@/components/TopMeshes";

/** Grid resolutions, kept in sync with the legacy page.tsx constants. */
const POINTER_BINS = 50;
const CAMERA_BINS = 36;
/** Ground-plane bin size (world units) for the floor-plan heatmap. */
const FLOOR_CELL_SIZE = 1;

/** On the session surface, scope a panel's query to the inspected session. */
function scoped(ctx: PanelContext): QueryParams {
  return ctx.surface === "session" && ctx.sessionId
    ? { ...ctx.params, session: ctx.sessionId }
    : ctx.params;
}

/** Top meshes — React/HTML list, half width. */
const topMeshesPanel = definePanel<MeshCount[]>({
  id: "top-meshes",
  title: TOP_MESHES_TITLE,
  subtitle: TOP_MESHES_SUBTITLE,
  span: 1,
  surfaces: ["overview", "session"],
  load: (ctx) =>
    ctx.api.topMeshes({ ...scoped(ctx), source: undefined, scene: undefined, limit: 25 }),
  render: ({ data }) => <TopMeshesView meshes={data ?? []} />,
});

/** Pointer heatmap — 2D canvas, half width. */
const pointerHeatmapPanel = definePanel<HeatmapBin[]>({
  id: "pointer-heatmap",
  title: POINTER_HEATMAP_TITLE,
  subtitle: POINTER_HEATMAP_SUBTITLE,
  span: 1,
  surfaces: ["overview", "session"],
  clientOnly: true,
  load: (ctx) => ctx.api.pointerHeatmap({ ...scoped(ctx), bins: POINTER_BINS }),
  render: ({ data }) => <PointerHeatmapView bins={data ?? []} gridSize={POINTER_BINS} />,
});

/** View-direction dome — 3D Babylon scene, full width. */
const cameraDomePanel = definePanel<DirectionBin[]>({
  id: "camera-dome-3d",
  title: CAMERA_DOME_TITLE,
  subtitle: CAMERA_DOME_SUBTITLE,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  load: (ctx) => ctx.api.cameraHeatmap({ ...scoped(ctx), source: undefined, bins: CAMERA_BINS }),
  render: ({ data }) => <CameraDome3DView bins={data ?? []} gridSize={CAMERA_BINS} />,
});

/**
 * Floor-plan dwell heatmap — 2D canvas, half width. Top-down X/Z heat of where
 * visitors stood/lingered (ADR 0026). Hidden in the orbit/"viewer" camera mode,
 * where a camera position orbits the model rather than tracking a walker.
 */
const floorPlanPanel = definePanel<PositionBin[]>({
  id: "floor-plan",
  title: FLOOR_PLAN_TITLE,
  subtitle: FLOOR_PLAN_SUBTITLE,
  help: FLOOR_PLAN_HELP,
  span: 1,
  surfaces: ["overview", "session"],
  clientOnly: true,
  enabled: (ctx) => ctx.filters.cameraMode !== "viewer",
  load: (ctx) => ctx.api.cameraPositionHeatmap({ ...scoped(ctx), cellSize: FLOOR_CELL_SIZE }),
  render: ({ data }) => <FloorPlanHeatmapView bins={data ?? []} cellSize={FLOOR_CELL_SIZE} />,
});

/**
 * Built-in panels migrated to the ADR 0036 contract. Self-hosters append their
 * own `PanelDefinition`s to this array (build-time registration).
 */
export const builtinPanels: PanelDefinition<unknown>[] = [
  topMeshesPanel,
  pointerHeatmapPanel,
  cameraDomePanel,
  floorPlanPanel,
] as PanelDefinition<unknown>[];
