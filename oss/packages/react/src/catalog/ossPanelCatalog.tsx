"use client";

// The portable OSS panel catalog (ADR 0036 / ADR 0039 / ADR 0047).
//
// This module is the SINGLE SOURCE OF TRUTH for the built-in analytics panels.
// The standalone dashboard and any embedding host both build their panel set
// from `ossPanelCatalog` — a host adds nothing but chrome + layout.
//
// Babylon stays optional: the 3D panels' view modules are code-split via
// `React.lazy`, so this module's static import graph never pulls in
// `@babylonjs/*`. Their title/subtitle/help copy lives in the Babylon-free
// `./views3d/labels` module so the catalog can describe a 3D panel without
// loading its (heavy) view.

import { lazy, Suspense, type ReactNode } from "react";

import { definePanel } from "../panels/contract";
import type { PanelContext, PanelDefinition, PanelSettings } from "../panels/contract";
import { pickInterval } from "../filters";
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
  MeshBlindSpot,
  MeshInteractionKind,
  MeshSourceCount,
  MeshTrendPoint,
  PerfDistribution,
  PerfHeatmapVoxel,
  PositionBin,
  QueryParams,
  RenderScaleTruth as RenderScaleTruthData,
  SceneProxyMesh,
  SceneRetentionLink,
  WorldHeatmapBin,
  XrLocomotionStat,
} from "../api";
import { mergeSceneProxies } from "./lib/sceneProxies";

// --- 2D / HTML / canvas views (Babylon-free — imported eagerly). ------------
import {
  FloorPlanHeatmapView,
  FLOOR_PLAN_TITLE,
  FLOOR_PLAN_SUBTITLE,
  FLOOR_PLAN_HELP,
} from "./views/FloorPlanHeatmap";
import {
  DesireLinesView,
  DESIRE_LINES_TITLE,
  DESIRE_LINES_SUBTITLE,
  DESIRE_LINES_HELP,
} from "./views/DesireLines";
import {
  MeshInteractionKindsView,
  MESH_KINDS_TITLE,
  MESH_KINDS_SUBTITLE,
  MESH_KINDS_HELP,
} from "./views/MeshInteractionKinds";
import {
  MeshLeaderboardView,
  MESH_LEADERBOARD_TITLE,
  MESH_LEADERBOARD_SUBTITLE,
  MESH_LEADERBOARD_HELP,
} from "./views/MeshLeaderboard";
import {
  BlindSpotReportView,
  BLIND_SPOTS_TITLE,
  BLIND_SPOTS_SUBTITLE,
  BLIND_SPOTS_HELP,
} from "./views/BlindSpotReport";
import {
  InputModalitySplitView,
  INPUT_MODALITY_TITLE,
  INPUT_MODALITY_SUBTITLE,
  INPUT_MODALITY_HELP,
} from "./views/InputModalitySplit";
import {
  DeadZoneReportView,
  DEAD_ZONE_TITLE,
  DEAD_ZONE_SUBTITLE,
  DEAD_ZONE_HELP,
} from "./views/DeadZoneReport";
import {
  PerfDistributionView,
  PERF_DISTRIBUTION_TITLE,
  PERF_DISTRIBUTION_SUBTITLE,
  PERF_DISTRIBUTION_HELP,
} from "./views/PerfDistribution";
import {
  RenderScaleTruthView,
  RENDER_SCALE_TITLE,
  RENDER_SCALE_SUBTITLE,
  RENDER_SCALE_HELP,
} from "./views/RenderScaleTruth";
import {
  NavigationMixView,
  NAVIGATION_MIX_TITLE,
  NAVIGATION_MIX_SUBTITLE,
} from "./views/NavigationMix";
import {
  XrLocomotionComfortView,
  XR_LOCOMOTION_TITLE,
  XR_LOCOMOTION_SUBTITLE,
} from "./views/XrLocomotionComfort";
import {
  PointerHeatmapView,
  POINTER_HEATMAP_TITLE,
  POINTER_HEATMAP_SUBTITLE,
} from "./views/PointerHeatmap";
import { TopMeshesView, TOP_MESHES_TITLE, TOP_MESHES_SUBTITLE } from "./views/TopMeshes";
import {
  SceneRetentionFunnelView,
  SCENE_RETENTION_TITLE,
  SCENE_RETENTION_SUBTITLE,
  SCENE_RETENTION_HELP,
} from "./views/SceneRetentionFunnel";

// --- 3D (Babylon-backed) view labels (Babylon-free copy) + lazy views. ------
import {
  CAMERA_DOME_TITLE,
  CAMERA_DOME_SUBTITLE,
  WORLD_HEATMAP_TITLE,
  WORLD_HEATMAP_SUBTITLE,
  PERF_HEATMAP_TITLE,
  PERF_HEATMAP_SUBTITLE,
  GAZE_CLICK_TITLE,
  GAZE_CLICK_SUBTITLE,
  FLOW_SANKEY_TITLE,
  FLOW_SANKEY_SUBTITLE,
  FLOW_SANKEY_HELP,
} from "./views3d/labels";

/**
 * The Babylon-backed views are code-split: each `import()` becomes its own chunk
 * that is only fetched when the panel actually renders. Keeping these as `lazy`
 * (rather than static imports) is what keeps `@babylonjs/*` out of the catalog's
 * static import graph — a consumer gets the full catalog with zero Babylon cost
 * until a 3D panel is shown.
 */
const CameraDome3DLazy = lazy(() =>
  import("./views3d/CameraDome3D").then((m) => ({ default: m.CameraDome3DView })),
);
const WorldHeatmap3DLazy = lazy(() =>
  import("./views3d/WorldHeatmap3D").then((m) => ({ default: m.WorldHeatmap3DView })),
);
const FlowSankey3DLazy = lazy(() =>
  import("./views3d/FlowSankey3D").then((m) => ({ default: m.FlowSankey3DView })),
);
const GazeClickDivergence3DLazy = lazy(() =>
  import("./views3d/GazeClickDivergence3D").then((m) => ({
    default: m.GazeClickDivergence3DView,
  })),
);

/** Suspense wrapper for a lazily loaded 3D panel body. */
function Lazy3D({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-[12rem] place-items-center text-sm text-fg-muted">
          Loading 3D view…
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

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

const PERF_HEATMAP_SETTINGS = {
  cellSize: {
    type: "number",
    label: "Voxel size",
    help: "World-space voxel size for binning frame_perf samples by camera position. Larger voxels smooth the map; smaller ones sharpen where FPS drops.",
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
 * Resolve the scene-proxy backdrop (ADR 0014) for the 3D world heatmap. When a
 * single scene/area is selected, anchor to just that area's geometry. Otherwise
 * (the default "All scenes") render the WHOLE building — every active area's proxy
 * merged into one backdrop (ADR 0040 §5) — so elevated levels and far areas are
 * always present and deterministic, instead of swapping to one section at a time as
 * the live avatar crosses boundaries. Returns [] when nothing anchors it.
 */
async function resolveProxyMeshes(ctx: PanelContext): Promise<SceneProxyMesh[]> {
  const sceneId = ctx.params.scene;
  if (sceneId) {
    const rep = await ctx.api.sceneRepresentation(sceneId).catch(() => null);
    return rep?.proxy?.meshes ?? [];
  }
  return mergeSceneProxies(ctx.api, ctx.params);
}

/** Top meshes — React/HTML list, half width. */
export const topMeshesPanel = definePanel<MeshCount[], typeof TOP_MESHES_SETTINGS>({
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

/**
 * Blind spots (#143) — React/HTML list, half width. The inverse of the mesh
 * leaderboards: meshes with high `mesh_visibility` on-screen time but little or
 * no `mesh_interaction` + `hover_dwell` engagement — rendered but never noticed.
 * Ranked most-seen-yet-least-touched first (server-side). Depends on object-dwell
 * capture being enabled; empty otherwise.
 */
export const blindSpotsPanel = definePanel<MeshBlindSpot[]>({
  id: "blind-spots",
  title: BLIND_SPOTS_TITLE,
  subtitle: BLIND_SPOTS_SUBTITLE,
  help: BLIND_SPOTS_HELP,
  span: 1,
  surfaces: ["overview", "session"],
  load: (ctx) => ctx.api.meshBlindSpots({ ...scoped(ctx), limit: 25 }),
  render: ({ data }) => <BlindSpotReportView meshes={data ?? []} />,
});

/** Pointer heatmap — 2D canvas, half width. */
export const pointerHeatmapPanel = definePanel<HeatmapBin[], typeof POINTER_HEATMAP_SETTINGS>({
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
export const cameraDomePanel = definePanel<DirectionBin[], typeof CAMERA_DOME_SETTINGS>({
  id: "camera-dome-3d",
  title: CAMERA_DOME_TITLE,
  subtitle: CAMERA_DOME_SUBTITLE,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  settings: CAMERA_DOME_SETTINGS,
  load: (ctx) =>
    ctx.api.cameraHeatmap({ ...scoped(ctx), source: undefined, bins: ctx.settings.bins }),
  render: ({ data, ctx }) => (
    <Lazy3D>
      <CameraDome3DLazy bins={data ?? []} gridSize={ctx.settings.bins} />
    </Lazy3D>
  ),
});

/**
 * Floor-plan dwell heatmap — 2D canvas, half width. Top-down X/Z heat of where
 * visitors stood/lingered (ADR 0026). Hidden in the orbit/"viewer" camera mode,
 * where a camera position orbits the model rather than tracking a walker.
 */
export const floorPlanPanel = definePanel<PositionBin[], typeof FLOOR_PLAN_SETTINGS>({
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
export const desireLinesPanel = definePanel<AggregateTrajectoryPoint[]>({
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
export const meshKindsPanel = definePanel<MeshInteractionKind[]>({
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
export const meshLeaderboardPanel = definePanel<MeshLeaderboardData>({
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
export const inputModalityPanel = definePanel<InputModalityData>({
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
export const deadZonePanel = definePanel<DeadZoneData>({
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
export const perfDistributionPanel = definePanel<PerfDistributionData>({
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
export const renderScalePanel = definePanel<RenderScaleTruthData>({
  id: "render-scale-truth",
  title: RENDER_SCALE_TITLE,
  subtitle: RENDER_SCALE_SUBTITLE,
  help: RENDER_SCALE_HELP,
  span: 1,
  surfaces: ["overview", "session"],
  load: (ctx) => ctx.api.renderScale(scoped(ctx)),
  render: ({ data }) => <RenderScaleTruthView data={data} />,
});

/** World (click) heatmap data: voxels + the scene-proxy backdrop + scene totals. */
interface WorldHeatmapData {
  voxels: WorldHeatmapBin[];
  proxyMeshes: SceneProxyMesh[];
  /** Scene-wide totals (ADR 0040 §3) behind the truncated voxel list. */
  totals: { cells: number; hits: number };
}

/**
 * World-space (3D) click heatmap — Babylon scene, full width. Voxel-binned
 * pointer hits in world space, drawn against the registered scene proxy as a
 * faint backdrop (ADR 0014). Client-only (Babylon loads in the browser). The
 * proxy is resolved alongside the voxels so the backdrop tracks the scene filter.
 */
export const worldHeatmapPanel = definePanel<WorldHeatmapData, typeof WORLD_HEATMAP_SETTINGS>({
  id: "world-heatmap-3d",
  title: WORLD_HEATMAP_TITLE,
  subtitle: WORLD_HEATMAP_SUBTITLE,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  settings: WORLD_HEATMAP_SETTINGS,
  load: async (ctx) => {
    const [voxels, proxyMeshes, stats] = await Promise.all([
      ctx.api.worldHeatmap({ ...scoped(ctx), cellSize: ctx.settings.cellSize }),
      resolveProxyMeshes(ctx),
      ctx.api.worldHeatmapStats({ ...scoped(ctx), cellSize: ctx.settings.cellSize }),
    ]);
    return { voxels, proxyMeshes, totals: { cells: stats.cells, hits: stats.hits } };
  },
  render: ({ data, ctx }) => (
    <Lazy3D>
      <WorldHeatmap3DLazy
        voxels={data.voxels}
        cellSize={ctx.settings.cellSize}
        proxyMeshes={data.proxyMeshes}
        totals={data.totals}
      />
    </Lazy3D>
  ),
});

/** Perf (FPS) heatmap data: the raw perf voxels + the scene-proxy backdrop. */
interface PerfHeatmapData {
  voxels: PerfHeatmapVoxel[];
  proxyMeshes: SceneProxyMesh[];
}

/**
 * Performance heatmap (3D) — where FPS is bad in the scene (#145). `frame_perf`
 * samples are voxel-binned by the camera position captured at each sample, then
 * re-expressed for the shared {@link WorldHeatmap3DView}: the heat channel encodes
 * *slowness* (`(maxAvgFps + 1) - avgFps`) so the slowest cells read hottest and
 * biggest while every sampled voxel stays visible. Because the heat is a derived
 * "slowness" score rather than a raw count, each marker also carries an honest
 * per-voxel label (avg / min fps + sample count) surfaced on hover. Client-only
 * (Babylon loads in the browser); the scene proxy is resolved alongside so the
 * backdrop tracks the active scene filter (ADR 0014).
 */
export const perfHeatmapPanel = definePanel<PerfHeatmapData, typeof PERF_HEATMAP_SETTINGS>({
  id: "perf-heatmap-3d",
  title: PERF_HEATMAP_TITLE,
  subtitle: PERF_HEATMAP_SUBTITLE,
  span: 2,
  surfaces: ["overview", "session"],
  clientOnly: true,
  settings: PERF_HEATMAP_SETTINGS,
  load: async (ctx) => {
    const [voxels, proxyMeshes] = await Promise.all([
      ctx.api.perfHeatmap({ ...scoped(ctx), cellSize: ctx.settings.cellSize }),
      resolveProxyMeshes(ctx),
    ]);
    return { voxels, proxyMeshes };
  },
  render: ({ data, ctx }) => {
    // Re-express FPS as a "slowness" heat: slowest cell → hottest/biggest, and
    // every sampled voxel keeps a value ≥ 1 so nothing drops out of the render.
    const maxAvgFps = data.voxels.reduce((m, v) => Math.max(m, v.avgFps), 0);
    const heatVoxels: WorldHeatmapBin[] = data.voxels.map((v) => ({
      vx: v.vx,
      vy: v.vy,
      vz: v.vz,
      count: maxAvgFps + 1 - v.avgFps,
    }));
    const voxelLabels = data.voxels.map(
      (v) =>
        `${Math.round(v.avgFps)} fps avg · ${Math.round(v.minFps)} fps min · ${v.samples} sample${
          v.samples === 1 ? "" : "s"
        }`,
    );
    return (
      <Lazy3D>
        <WorldHeatmap3DLazy
          voxels={heatVoxels}
          cellSize={ctx.settings.cellSize}
          proxyMeshes={data.proxyMeshes}
          voxelLabels={voxelLabels}
          legendTitle="FPS (slowest = hottest)"
          legendLow="smooth"
          legendHigh="janky"
          legendNote="Each marker is a voxel where frame_perf was sampled, placed at the camera position. Color & size scale with slowness (lower FPS = hotter/bigger), so your worst-performing spots stand out. Hover a cell for its average/min FPS and sample count."
          emptyLabel="No frame_perf samples with position in range. Position capture is opt-in — update your SDK to record where FPS drops."
        />
      </Lazy3D>
    );
  },
});

/**
 * Navigation-style mix — React/HTML breakdown, half width. Orbit vs. pan vs.
 * dolly vs. zoom vs. roll vs. fly share of deliberate camera navigation, plus
 * average gesture duration, from `camera_gesture` (ADR 0025). Gesture magnitude
 * isn't aggregated today, so v1 reports counts + duration only (#69).
 */
export const navigationMixPanel = definePanel<CameraGestureStat[]>({
  id: "navigation-mix",
  title: NAVIGATION_MIX_TITLE,
  subtitle: NAVIGATION_MIX_SUBTITLE,
  span: 1,
  surfaces: ["overview", "session"],
  load: (ctx) => ctx.api.cameraGestures({ ...scoped(ctx), source: undefined }),
  render: ({ data }) => <NavigationMixView stats={data ?? []} />,
});

/**
 * VR comfort & locomotion (#148) — React/HTML breakdown, half width. The XR-
 * focused companion to the navigation-style mix: for sessions using an XR input
 * source, the teleport vs. smooth-locomotion vs. navigate share plus a heavy-vs-
 * light locomotion / early-exit correlation, all from existing `camera_gesture` +
 * `mesh_interaction` + session-span data (ADR 0025). No schema change.
 */
export const xrLocomotionComfortPanel = definePanel<XrLocomotionStat[]>({
  id: "xr-locomotion-comfort",
  title: XR_LOCOMOTION_TITLE,
  subtitle: XR_LOCOMOTION_SUBTITLE,
  span: 1,
  surfaces: ["overview", "session"],
  load: (ctx) => ctx.api.xrLocomotion({ ...scoped(ctx), source: undefined }),
  render: ({ data }) => <XrLocomotionComfortView stats={data ?? []} />,
});

/**
 * Scene/level retention funnel (#147) — React/HTML, half width. A canned Sankey
 * preset built directly from `scene_change` markers: session counts flowing
 * scene → scene in observed order, weighted by distinct sessions, so
 * level-to-level drop-off is visible with zero configuration (the complement to
 * the caller-authored funnel, ADR 0038). Overview-only — it's a crowd view of
 * how visitors move between areas, not a single-session drill-down.
 */
export const sceneRetentionPanel = definePanel<SceneRetentionLink[]>({
  id: "scene-retention-funnel",
  title: SCENE_RETENTION_TITLE,
  subtitle: SCENE_RETENTION_SUBTITLE,
  help: SCENE_RETENTION_HELP,
  span: 1,
  surfaces: ["overview"],
  load: (ctx) => ctx.api.sceneRetention({ ...scoped(ctx), scene: undefined, limit: 50 }),
  render: ({ data }) => <SceneRetentionFunnelView links={data ?? []} />,
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
export const flowPanel = definePanel<FlowData, typeof FLOW_SANKEY_SETTINGS>({
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
    <Lazy3D>
      <FlowSankey3DLazy
        links={data.links}
        gridSize={CAMERA_BINS}
        proxyMeshes={data.proxyMeshes}
        maxLinks={ctx.settings.maxLinks}
        baseUrl={ctx.baseUrl}
        apiKey={ctx.apiKey}
        flowQuery={data.flowQuery}
        hasFirstPerson={ctx.capabilities.hasFirstPerson}
      />
    </Lazy3D>
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
export const divergencePanel = definePanel<DivergenceData, typeof DIVERGENCE_SETTINGS>({
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
    <Lazy3D>
      <GazeClickDivergence3DLazy
        gazeVoxels={data.gaze}
        clickVoxels={data.click}
        cellSize={ctx.settings.cellSize}
        proxyMeshes={data.proxyMeshes}
      />
    </Lazy3D>
  ),
});

/**
 * The complete, portable OSS panel catalog. This is the single source of truth
 * for the built-in analytics panels (ADR 0036 / ADR 0047): a host builds its
 * entire panel set from this array and adds only chrome + layout. Self-hosters
 * append their own `PanelDefinition`s (build-time registration).
 */
export const ossPanelCatalog: PanelDefinition<unknown>[] = [
  topMeshesPanel,
  meshLeaderboardPanel,
  blindSpotsPanel,
  pointerHeatmapPanel,
  cameraDomePanel,
  floorPlanPanel,
  desireLinesPanel,
  meshKindsPanel,
  inputModalityPanel,
  renderScalePanel,
  perfDistributionPanel,
  worldHeatmapPanel,
  perfHeatmapPanel,
  navigationMixPanel,
  xrLocomotionComfortPanel,
  sceneRetentionPanel,
  deadZonePanel,
  flowPanel,
  divergencePanel,
] as PanelDefinition<unknown>[];
