"use client";

import { definePanel, type PanelContext, type PanelDefinition } from "@uptimizr/react";
import type {
  AggregateTrajectoryPoint,
  CameraGestureStat,
  DirectionBin,
  FlowLink,
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
  FlowSankey3DView,
  FLOW_SANKEY_TITLE,
  FLOW_SANKEY_SUBTITLE,
  FLOW_SANKEY_HELP,
} from "@/components/FlowSankey3D";
import {
  GazeClickDivergence3DView,
  GAZE_CLICK_TITLE,
  GAZE_CLICK_SUBTITLE,
} from "@/components/GazeClickDivergence3D";
import {
  NavigationMixView,
  NAVIGATION_MIX_TITLE,
  NAVIGATION_MIX_SUBTITLE,
} from "@/components/NavigationMix";
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
/** Max aggregate flow links drawn before the panel caps for legibility. */
const FLOW_MAX_LINKS = 80;

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
 * Navigation-style mix — React/HTML breakdown, half width. Orbit vs. pan vs.
 * dolly vs. zoom vs. roll vs. fly share of deliberate camera navigation, plus
 * average gesture duration, from `camera_gesture` (ADR 0025). Gesture magnitude
 * isn't aggregated today, so v1 reports counts + duration only (#69).
 */
const navigationMixPanel = definePanel<CameraGestureStat[]>({
  id: "navigation-mix",
  title: NAVIGATION_MIX_TITLE,
  subtitle: NAVIGATION_MIX_SUBTITLE,
  span: 1,
  surfaces: ["overview", "session"],
  load: (ctx) => ctx.api.cameraGestures({ ...scoped(ctx), source: undefined }),
  render: ({ data }) => <NavigationMixView stats={data ?? []} />,
});

/** Aggregate gaze→mesh flow data: position-aware links + the scene-proxy backdrop. */
interface FlowData {
  links: FlowLink[];
  proxyMeshes: SceneProxyMesh[];
  /** Resolved base query (no camera mode) the panel re-issues per walk/orbit/all. */
  flowQuery: QueryParams;
}

/**
 * Click → part flow (Flow Sankey, 3D) — Babylon scene, full width. Aggregate
 * gaze-direction → clicked-mesh links (no timeline), with a position-aware
 * standpoint mode (§7.8). The panel owns the camera-mode dimension: it re-issues
 * the flow query scoped to walk/orbit/all from `ctx.baseUrl`/`ctx.apiKey`, so
 * `load` only seeds the initial rows + proxy backdrop. Client-only (Babylon).
 */
const flowPanel = definePanel<FlowData>({
  id: "flow-sankey-3d",
  title: FLOW_SANKEY_TITLE,
  subtitle: FLOW_SANKEY_SUBTITLE,
  help: FLOW_SANKEY_HELP,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  load: async (ctx) => {
    // The panel re-issues the flow query per camera mode, so the base query
    // strips the global camera-mode filter (the panel's own toggle owns it).
    const flowQuery: QueryParams = { ...scoped(ctx), cameraMode: undefined };
    const [links, proxyMeshes] = await Promise.all([
      ctx.api.flowHeatmap({ ...flowQuery, bins: CAMERA_BINS, limit: 400, groupByOrigin: true }),
      resolveProxyMeshes(ctx),
    ]);
    return { links, proxyMeshes, flowQuery };
  },
  render: ({ data, ctx }) => (
    <FlowSankey3DView
      links={data.links}
      gridSize={CAMERA_BINS}
      proxyMeshes={data.proxyMeshes}
      maxLinks={FLOW_MAX_LINKS}
      baseUrl={ctx.baseUrl}
      apiKey={ctx.apiKey}
      flowQuery={data.flowQuery}
      hasFirstPerson={ctx.capabilities.hasFirstPerson}
    />
  ),
});

/** Gaze-vs-click divergence data: both voxel grids (equal cellSize) + backdrop. */
interface DivergenceData {
  gaze: WorldHeatmapBin[];
  click: WorldHeatmapBin[];
  proxyMeshes: SceneProxyMesh[];
}

/**
 * Gaze vs. click divergence overlay — Babylon scene, full width. Overlays where
 * viewers *look* (gaze heat) against where they *act* (pointer world heat) over
 * the scene proxy (ADR 0014), to reveal attention that doesn't convert to
 * interaction (ADR 0030). Both grids load at the same `WORLD_CELL_SIZE` so the
 * voxels align and the client-side divergence field is meaningful. Client-only.
 */
const divergencePanel = definePanel<DivergenceData>({
  id: "gaze-click-divergence-3d",
  title: GAZE_CLICK_TITLE,
  subtitle: GAZE_CLICK_SUBTITLE,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  load: async (ctx) => {
    const [gaze, click, proxyMeshes] = await Promise.all([
      ctx.api.gazeHeatmap({ ...scoped(ctx), source: undefined, cellSize: WORLD_CELL_SIZE }),
      ctx.api.worldHeatmap({ ...scoped(ctx), cellSize: WORLD_CELL_SIZE }),
      resolveProxyMeshes(ctx),
    ]);
    return { gaze, click, proxyMeshes };
  },
  render: ({ data }) => (
    <GazeClickDivergence3DView
      gazeVoxels={data.gaze}
      clickVoxels={data.click}
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
  navigationMixPanel,
  flowPanel,
  divergencePanel,
] as PanelDefinition<unknown>[];
