"use client";

import {
  definePanel,
  pickInterval,
  type PanelContext,
  type PanelDefinition,
  type PanelSettings,
} from "@uptimizr/react";
import type {
  AggregateTrajectoryPoint,
  CameraGestureStat,
  CoverageVoxel,
  DirectionBin,
  FlowLink,
  FpsHistogramBin,
  HeatmapBin,
  InputActionCount,
  InteractionSource,
  MeshCount,
  MeshInteractionKind,
  MeshSourceCount,
  MeshTrendPoint,
  PerfDistribution,
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
  MeshLeaderboardView,
  MESH_LEADERBOARD_TITLE,
  MESH_LEADERBOARD_SUBTITLE,
  MESH_LEADERBOARD_HELP,
} from "@/components/MeshLeaderboard";
import {
  InputModalitySplitView,
  INPUT_MODALITY_TITLE,
  INPUT_MODALITY_SUBTITLE,
  INPUT_MODALITY_HELP,
} from "@/components/InputModalitySplit";
import {
  DeadZoneReportView,
  DEAD_ZONE_TITLE,
  DEAD_ZONE_SUBTITLE,
  DEAD_ZONE_HELP,
} from "@/components/DeadZoneReport";
import {
  PerfDistributionView,
  PERF_DISTRIBUTION_TITLE,
  PERF_DISTRIBUTION_SUBTITLE,
  PERF_DISTRIBUTION_HELP,
} from "@/components/PerfDistribution";
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

/**
 * Floor-plan per-panel settings (ADR 0039). `cellSize` is the canonical first
 * example of a viewer-tunable setting (#79): the ground-plane bin size, exposed
 * as a clamped slider so a viewer can trade spatial resolution against smoothing
 * without editing the panel definition.
 */
const FLOOR_PLAN_SETTINGS = {
  cellSize: {
    type: "number",
    label: "Cell size",
    help: "Ground-plane bin size in world units. Larger cells smooth the dwell heat; smaller cells sharpen spatial resolution.",
    default: FLOOR_CELL_SIZE,
    min: 0.25,
    max: 5,
    step: 0.25,
    unit: "m",
  },
} as const satisfies PanelSettings;

/**
 * Per-panel data-resolution settings (ADR 0039, #79). Each exposes the binning /
 * cap constant the panel previously hardcoded as a viewer-tunable slider; changing
 * one re-runs the panel's `load` (it feeds the query), exactly like `cellSize`.
 */
const POINTER_HEATMAP_SETTINGS = {
  bins: {
    type: "number",
    label: "Grid resolution",
    help: "Bins per axis for the 2D pointer grid. More bins sharpen detail; fewer smooth the heat.",
    default: POINTER_BINS,
    min: 10,
    max: 120,
    step: 10,
  },
} as const satisfies PanelSettings;

const CAMERA_DOME_SETTINGS = {
  bins: {
    type: "number",
    label: "Direction resolution",
    help: "Angular bins for the view-direction dome. More bins resolve finer look-directions; fewer aggregate them.",
    default: CAMERA_BINS,
    min: 12,
    max: 72,
    step: 6,
  },
} as const satisfies PanelSettings;

const WORLD_HEATMAP_SETTINGS = {
  cellSize: {
    type: "number",
    label: "Voxel size",
    help: "World-space voxel size for binning pointer hits. Larger voxels smooth the heat; smaller ones sharpen spatial detail.",
    default: WORLD_CELL_SIZE,
    min: 0.1,
    max: 2,
    step: 0.1,
    unit: "m",
  },
} as const satisfies PanelSettings;

const DIVERGENCE_SETTINGS = {
  cellSize: {
    type: "number",
    label: "Voxel size",
    help: "Shared world-space voxel size for both the gaze and click grids, so the divergence field stays aligned.",
    default: WORLD_CELL_SIZE,
    min: 0.1,
    max: 2,
    step: 0.1,
    unit: "m",
  },
} as const satisfies PanelSettings;

const FLOW_SANKEY_SETTINGS = {
  maxLinks: {
    type: "number",
    label: "Max links",
    help: "Maximum aggregate flow links drawn before the panel caps for legibility.",
    default: FLOW_MAX_LINKS,
    min: 10,
    max: 200,
    step: 10,
  },
} as const satisfies PanelSettings;

const TOP_MESHES_SETTINGS = {
  limit: {
    type: "number",
    label: "Top N",
    help: "How many meshes to rank in the list.",
    default: 25,
    min: 5,
    max: 100,
    step: 5,
  },
} as const satisfies PanelSettings;

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
const topMeshesPanel = definePanel<MeshCount[], typeof TOP_MESHES_SETTINGS>({
  id: "top-meshes",
  title: TOP_MESHES_TITLE,
  subtitle: TOP_MESHES_SUBTITLE,
  span: 1,
  surfaces: ["overview", "session"],
  settings: TOP_MESHES_SETTINGS,
  load: (ctx) =>
    ctx.api.topMeshes({
      ...scoped(ctx),
      source: undefined,
      scene: undefined,
      limit: ctx.settings.limit,
    }),
  render: ({ data }) => <TopMeshesView meshes={data ?? []} />,
});

/** Pointer heatmap — 2D canvas, half width. */
const pointerHeatmapPanel = definePanel<HeatmapBin[], typeof POINTER_HEATMAP_SETTINGS>({
  id: "pointer-heatmap",
  title: POINTER_HEATMAP_TITLE,
  subtitle: POINTER_HEATMAP_SUBTITLE,
  span: 1,
  surfaces: ["overview", "session"],
  clientOnly: true,
  settings: POINTER_HEATMAP_SETTINGS,
  load: (ctx) => ctx.api.pointerHeatmap({ ...scoped(ctx), bins: ctx.settings.bins }),
  render: ({ data, ctx }) => <PointerHeatmapView bins={data ?? []} gridSize={ctx.settings.bins} />,
});

/** View-direction dome — 3D Babylon scene, full width. */
const cameraDomePanel = definePanel<DirectionBin[], typeof CAMERA_DOME_SETTINGS>({
  id: "camera-dome-3d",
  title: CAMERA_DOME_TITLE,
  subtitle: CAMERA_DOME_SUBTITLE,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  settings: CAMERA_DOME_SETTINGS,
  load: (ctx) =>
    ctx.api.cameraHeatmap({ ...scoped(ctx), source: undefined, bins: ctx.settings.bins }),
  render: ({ data, ctx }) => <CameraDome3DView bins={data ?? []} gridSize={ctx.settings.bins} />,
});

/**
 * Floor-plan dwell heatmap — 2D canvas, half width. Top-down X/Z heat of where
 * visitors stood/lingered (ADR 0026). Hidden in the orbit/"viewer" camera mode,
 * where a camera position orbits the model rather than tracking a walker.
 */
const floorPlanPanel = definePanel<PositionBin[], typeof FLOOR_PLAN_SETTINGS>({
  id: "floor-plan",
  title: FLOOR_PLAN_TITLE,
  subtitle: FLOOR_PLAN_SUBTITLE,
  help: FLOOR_PLAN_HELP,
  span: 1,
  surfaces: ["overview", "session"],
  clientOnly: true,
  settings: FLOOR_PLAN_SETTINGS,
  enabled: (ctx) => ctx.filters.cameraMode !== "viewer",
  load: (ctx) => ctx.api.cameraPositionHeatmap({ ...scoped(ctx), cellSize: ctx.settings.cellSize }),
  render: ({ data, ctx }) => (
    <FloorPlanHeatmapView bins={data ?? []} cellSize={ctx.settings.cellSize} />
  ),
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

/** Aim the per-mesh trend at ~24 buckets across the active range for a sparkline. */
function trendInterval(ctx: PanelContext): number {
  const { since, until } = ctx.params;
  if (since == null || until == null || until <= since) return 3600;
  return pickInterval(until - since, 24);
}

/** Part-popularity leaderboard (#74) data: per-mesh source split + trend buckets. */
interface MeshLeaderboardData {
  sources: MeshSourceCount[];
  trend: MeshTrendPoint[];
}

/**
 * Part-popularity leaderboard (#74) — React/HTML, half width. Ranked meshes with
 * a per-mesh trend sparkline (rising/falling delta) and an expandable input-source
 * split. The total/rank derive from summing the source split, so two reads — the
 * per-(mesh,source) split and the per-(mesh,bucket) trend — power the whole panel.
 */
const meshLeaderboardPanel = definePanel<MeshLeaderboardData>({
  id: "mesh-leaderboard",
  title: MESH_LEADERBOARD_TITLE,
  subtitle: MESH_LEADERBOARD_SUBTITLE,
  help: MESH_LEADERBOARD_HELP,
  span: 1,
  surfaces: ["overview", "session"],
  load: async (ctx) => {
    const [sources, trend] = await Promise.all([
      ctx.api.topMeshesBySource({ ...scoped(ctx), source: undefined, limit: 400 }),
      ctx.api.topMeshesTrend({
        ...scoped(ctx),
        source: undefined,
        interval: trendInterval(ctx),
        limit: 2000,
      }),
    ]);
    return { sources, trend };
  },
  render: ({ data }) => (
    <MeshLeaderboardView sources={data.sources ?? []} trend={data.trend ?? []} />
  ),
});

/** Input-modality split (#75) data: per-source share + most-used shortcuts. */
interface InputModalityData {
  sources: InteractionSource[];
  actions: InputActionCount[];
}

/**
 * Input-modality split + most-used shortcuts (#75, ADR 0023) — React/HTML, half
 * width. The per-source interaction share (from the input-source breakdown,
 * ADR 0011) paired with the most-used app-level `input_action` shortcuts. Two
 * reads: the existing source breakdown and the new shortcut leaderboard.
 */
const inputModalityPanel = definePanel<InputModalityData>({
  id: "input-modality-split",
  title: INPUT_MODALITY_TITLE,
  subtitle: INPUT_MODALITY_SUBTITLE,
  help: INPUT_MODALITY_HELP,
  span: 1,
  surfaces: ["overview", "session"],
  load: async (ctx) => {
    const [sources, actions] = await Promise.all([
      ctx.api.interactionsBySource({ ...scoped(ctx), source: undefined, limit: 100 }),
      ctx.api.topInputActions({ ...scoped(ctx), source: undefined, limit: 50 }),
    ]);
    return { sources, actions };
  },
  render: ({ data }) => (
    <InputModalitySplitView sources={data.sources ?? []} actions={data.actions ?? []} />
  ),
});

/** Dead-zone report (#76) data: scene-coverage voxels + the registered proxy. */
interface DeadZoneData {
  coverage: CoverageVoxel[];
  proxyMeshes: SceneProxyMesh[];
}

/**
 * Dead-zone report (#76) — React/HTML table, half width. The coldest proxy meshes
 * by camera proximity: the inverse of scene coverage, computed client-side by
 * intersecting the occupied camera-position voxels with the registered scene proxy
 * (ADR 0014). Renders a graceful empty-state/CTA when no proxy is registered.
 */
const deadZonePanel = definePanel<DeadZoneData>({
  id: "dead-zone-report",
  title: DEAD_ZONE_TITLE,
  subtitle: DEAD_ZONE_SUBTITLE,
  help: DEAD_ZONE_HELP,
  span: 1,
  surfaces: ["overview", "session"],
  load: async (ctx) => {
    const [coverage, proxyMeshes] = await Promise.all([
      ctx.api.coverage({ ...scoped(ctx), cellSize: FLOOR_CELL_SIZE }),
      resolveProxyMeshes(ctx),
    ]);
    return { coverage, proxyMeshes };
  },
  render: ({ data }) => (
    <DeadZoneReportView
      coverage={data.coverage ?? []}
      proxyMeshes={data.proxyMeshes ?? []}
      cellSize={FLOOR_CELL_SIZE}
    />
  ),
});

/** Performance distribution (#77) data: the FPS percentile bands + histogram. */
interface PerfDistributionData {
  distribution: PerfDistribution;
  histogram: FpsHistogramBin[];
}

/**
 * Performance distribution histogram (#77, ADR 0028 §1) — React/HTML, half width.
 * The p05/p50/p95 FPS bands plus a per-session median-FPS histogram, as a reusable
 * panel. No new aggregation — it wraps the existing `perfDistribution` +
 * `fpsHistogram` reads (the `PerformanceSummaryPanel` only shows avg/p50/min).
 */
const perfDistributionPanel = definePanel<PerfDistributionData>({
  id: "perf-distribution",
  title: PERF_DISTRIBUTION_TITLE,
  subtitle: PERF_DISTRIBUTION_SUBTITLE,
  help: PERF_DISTRIBUTION_HELP,
  span: 1,
  surfaces: ["overview", "session"],
  load: async (ctx) => {
    const [distribution, histogram] = await Promise.all([
      ctx.api.perfDistribution(scoped(ctx)),
      ctx.api.fpsHistogram(scoped(ctx)),
    ]);
    return { distribution, histogram };
  },
  render: ({ data }) => (
    <PerfDistributionView distribution={data.distribution} histogram={data.histogram ?? []} />
  ),
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
const worldHeatmapPanel = definePanel<WorldHeatmapData, typeof WORLD_HEATMAP_SETTINGS>({
  id: "world-heatmap-3d",
  title: WORLD_HEATMAP_TITLE,
  subtitle: WORLD_HEATMAP_SUBTITLE,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  settings: WORLD_HEATMAP_SETTINGS,
  load: async (ctx) => {
    const [voxels, proxyMeshes] = await Promise.all([
      ctx.api.worldHeatmap({ ...scoped(ctx), cellSize: ctx.settings.cellSize }),
      resolveProxyMeshes(ctx),
    ]);
    return { voxels, proxyMeshes };
  },
  render: ({ data, ctx }) => (
    <WorldHeatmap3DView
      voxels={data.voxels}
      cellSize={ctx.settings.cellSize}
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
const flowPanel = definePanel<FlowData, typeof FLOW_SANKEY_SETTINGS>({
  id: "flow-sankey-3d",
  title: FLOW_SANKEY_TITLE,
  subtitle: FLOW_SANKEY_SUBTITLE,
  help: FLOW_SANKEY_HELP,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  settings: FLOW_SANKEY_SETTINGS,
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
      maxLinks={ctx.settings.maxLinks}
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
const divergencePanel = definePanel<DivergenceData, typeof DIVERGENCE_SETTINGS>({
  id: "gaze-click-divergence-3d",
  title: GAZE_CLICK_TITLE,
  subtitle: GAZE_CLICK_SUBTITLE,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  settings: DIVERGENCE_SETTINGS,
  load: async (ctx) => {
    const [gaze, click, proxyMeshes] = await Promise.all([
      ctx.api.gazeHeatmap({ ...scoped(ctx), source: undefined, cellSize: ctx.settings.cellSize }),
      ctx.api.worldHeatmap({ ...scoped(ctx), cellSize: ctx.settings.cellSize }),
      resolveProxyMeshes(ctx),
    ]);
    return { gaze, click, proxyMeshes };
  },
  render: ({ data, ctx }) => (
    <GazeClickDivergence3DView
      gazeVoxels={data.gaze}
      clickVoxels={data.click}
      cellSize={ctx.settings.cellSize}
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
  meshLeaderboardPanel,
  pointerHeatmapPanel,
  cameraDomePanel,
  floorPlanPanel,
  desireLinesPanel,
  meshKindsPanel,
  inputModalityPanel,
  renderScalePanel,
  perfDistributionPanel,
  worldHeatmapPanel,
  navigationMixPanel,
  deadZonePanel,
  flowPanel,
  divergencePanel,
] as PanelDefinition<unknown>[];
