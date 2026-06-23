"use client";

import { definePanel, type PanelContext, type PanelDefinition } from "@uptimizr/react";
import type {
  AggregateTrajectoryPoint,
  DirectionBin,
  HeatmapBin,
  MeshCount,
  MeshInteractionKind,
  PositionBin,
  QueryParams,
  RenderScaleTruth as RenderScaleTruthData,
  SceneProxyMesh,
  WorldHeatmapBin,
} from "@/lib/api";
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
  DesireLinesView,
  DESIRE_LINES_TITLE,
  DESIRE_LINES_SUBTITLE,
  DESIRE_LINES_HELP,
} from "@/components/DesireLines";
import {
  MeshInteractionKindsView,
  MESH_KINDS_TITLE,
  MESH_KINDS_SUBTITLE,
  MESH_KINDS_HELP,
} from "@/components/MeshInteractionKinds";
import {
  RenderScaleTruthView,
  RENDER_SCALE_TITLE,
  RENDER_SCALE_SUBTITLE,
  RENDER_SCALE_HELP,
} from "@/components/RenderScaleTruth";
import {
  PointerHeatmapView,
  POINTER_HEATMAP_TITLE,
  POINTER_HEATMAP_SUBTITLE,
} from "@/components/PointerHeatmap";
import { TopMeshesView, TOP_MESHES_TITLE, TOP_MESHES_SUBTITLE } from "@/components/TopMeshes";
import {
  WorldHeatmap3DView,
  WORLD_HEATMAP_TITLE,
  WORLD_HEATMAP_SUBTITLE,
} from "@/components/WorldHeatmap3D";

/** Grid resolutions, kept in sync with the legacy page.tsx constants. */
const POINTER_BINS = 50;
const CAMERA_BINS = 36;
/** Ground-plane bin size (world units) for the floor-plan heatmap. */
const FLOOR_CELL_SIZE = 1;
/** Voxel size (world units) for the 3D world (click) heatmap. */
const WORLD_CELL_SIZE = 0.5;

/** On the session surface, scope a panel's query to the inspected session. */
function scoped(ctx: PanelContext): QueryParams {
  return ctx.surface === "session" && ctx.sessionId
    ? { ...ctx.params, session: ctx.sessionId }
    : ctx.params;
}

/**
 * Resolve the scene-proxy backdrop (ADR 0014) for the 3D world heatmap: use the
 * selected scene, or fall back to the sole scene when the project has exactly
 * one (mirrors the legacy dashboard so rays/voxels read against geometry instead
 * of floating in empty space). Returns [] when no scene anchors it.
 */
async function resolveProxyMeshes(ctx: PanelContext): Promise<SceneProxyMesh[]> {
  let sceneId = ctx.params.scene;
  if (!sceneId) {
    const scenes = await ctx.api.scenes(ctx.params).catch(() => []);
    if (scenes.length === 1) sceneId = scenes[0]?.scene_id;
  }
  if (!sceneId) return [];
  const rep = await ctx.api.sceneRepresentation(sceneId).catch(() => null);
  return rep?.proxy?.meshes ?? [];
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
 * Aggregate desire lines (#73, ADR 0037) — 2D canvas, half width. Every
 * session's binned camera path overlaid as a faint poly-line; common routes
 * self-reinforce into bright desire lines. Overview-only (it's a crowd view) and
 * hidden in the orbit/"viewer" camera mode, where there is no walked path.
 */
const desireLinesPanel = definePanel<AggregateTrajectoryPoint[]>({
  id: "desire-lines",
  title: DESIRE_LINES_TITLE,
  subtitle: DESIRE_LINES_SUBTITLE,
  help: DESIRE_LINES_HELP,
  span: 1,
  surfaces: ["overview"],
  clientOnly: true,
  enabled: (ctx) => ctx.filters.cameraMode !== "viewer",
  load: (ctx) => ctx.api.aggregatePaths({ ...scoped(ctx), cellSize: FLOOR_CELL_SIZE }),
  render: ({ data }) => <DesireLinesView points={data ?? []} />,
});

/**
 * Interaction-kind breakdown (#72, ADR 0023) — React/HTML stacked bars, half
 * width. Per-mesh split of how visitors act on objects (hover / pick / drag / …).
 */
const meshKindsPanel = definePanel<MeshInteractionKind[]>({
  id: "mesh-interaction-kinds",
  title: MESH_KINDS_TITLE,
  subtitle: MESH_KINDS_SUBTITLE,
  help: MESH_KINDS_HELP,
  span: 1,
  surfaces: ["overview", "session"],
  load: (ctx) => ctx.api.meshKinds({ ...scoped(ctx), limit: 200 }),
  render: ({ data }) => <MeshInteractionKindsView rows={data ?? []} />,
});

/**
 * Render-scale truth (#71, ADR 0021) — React/HTML stat block, half width. FPS
 * paired with the resolution the engine actually rendered at, flagging "good FPS
 * at a low render scale". A single aggregate row, so no client-only Babylon.
 */
const renderScalePanel = definePanel<RenderScaleTruthData>({
  id: "render-scale-truth",
  title: RENDER_SCALE_TITLE,
  subtitle: RENDER_SCALE_SUBTITLE,
  help: RENDER_SCALE_HELP,
  span: 1,
  surfaces: ["overview", "session"],
  load: (ctx) => ctx.api.renderScale(scoped(ctx)),
  render: ({ data }) => <RenderScaleTruthView data={data} />,
});

/** World (click) heatmap data: voxels + the scene-proxy backdrop. */
interface WorldHeatmapData {
  voxels: WorldHeatmapBin[];
  proxyMeshes: SceneProxyMesh[];
}

/**
 * World-space (3D) click heatmap — Babylon scene, full width. Voxel-binned
 * pointer hits in world space, drawn against the registered scene proxy as a
 * faint backdrop (ADR 0014). Client-only (Babylon loads in the browser). The
 * proxy is resolved alongside the voxels so the backdrop tracks the scene filter.
 */
const worldHeatmapPanel = definePanel<WorldHeatmapData>({
  id: "world-heatmap-3d",
  title: WORLD_HEATMAP_TITLE,
  subtitle: WORLD_HEATMAP_SUBTITLE,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  load: async (ctx) => {
    const [voxels, proxyMeshes] = await Promise.all([
      ctx.api.worldHeatmap({ ...scoped(ctx), cellSize: WORLD_CELL_SIZE }),
      resolveProxyMeshes(ctx),
    ]);
    return { voxels, proxyMeshes };
  },
  render: ({ data }) => (
    <WorldHeatmap3DView
      voxels={data.voxels}
      cellSize={WORLD_CELL_SIZE}
      proxyMeshes={data.proxyMeshes}
    />
  ),
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
  desireLinesPanel,
  meshKindsPanel,
  renderScalePanel,
  worldHeatmapPanel,
] as PanelDefinition<unknown>[];
