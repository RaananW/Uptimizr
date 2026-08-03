// @uptimizr/react — embeddable React analytics panels for the Uptimizr collector.
//
// Wrap your app in <UptimizrProvider endpoint apiKey> and drop in any panel.
// Panels read the collector query API through the shared CollectorApi client
// (browser → query API only; never the database — ADR 0004).

export * from "./api";
export { heatRgb, HEAT_GRADIENT, percentileMax } from "./heat";
export { heatColor, formatNumber, formatTime, parseTimestamp } from "./format";
export { drawPointerHeatmap, drawDirectionHeatmap, HEATMAP_BACKGROUND } from "./draw";
export { UptimizrProvider, useUptimizr, useOptionalUptimizr, useCollectorApi } from "./provider";
export { useAsync } from "./useAsync";
export type { AsyncState } from "./useAsync";

// Global filter state + helpers (shared by the dashboard and the panel contract).
export {
  DEFAULT_FILTERS,
  TIME_PRESETS,
  INPUT_SOURCES,
  resolveRange,
  toQueryParams,
  pickInterval,
  formatSource,
} from "./filters";
export type { FilterState, TimeWindow } from "./filters";
export type { LiveEvent, LiveStatus, LiveSessionState } from "./live";
export { useLiveSession, useSessionTail } from "./live-hooks";

// Extensible dashboard panel contract (ADR 0036, extended by ADR 0039).
export { definePanel, PANEL_CONTRACT_VERSION } from "./panels/contract";
export type {
  PanelDefinition,
  PanelContext,
  PanelDataContext,
  PanelActions,
  PanelLive,
  PanelCapabilities,
  PanelSurface,
  PanelSpan,
  PanelSettingSpec,
  NumberSettingSpec,
  BooleanSettingSpec,
  SelectSettingSpec,
  PanelSettings,
  PanelSettingValue,
  AnyPanelSettingValue,
  ResolvedPanelSettings,
} from "./panels/contract";
export {
  resolvePanelSettings,
  coercePanelSetting,
  pruneDefaultOverrides,
  createLocalStoragePanelStore,
  memoryPanelStore,
  EMPTY_PANEL_STATE,
} from "./panels/settings";
export type { PanelState, PanelStateStore } from "./panels/settings";

// Runtime / remote panel loading (ADR 0041). The contract is designed so panels
// can be discovered and loaded at runtime behind the same `PanelDefinition`.
export {
  fetchPanelManifest,
  loadRemotePanels,
  mergePanels,
  isPanelDefinition,
  isPanelManifest,
  isContractCompatible,
} from "./panels/remote";
export type {
  PanelManifest,
  PanelManifestEntry,
  RemotePanelError,
  RemotePanelErrorCode,
  LoadRemotePanelsResult,
  LoadRemotePanelsOptions,
  FetchManifestOptions,
  ModuleImporter,
} from "./panels/remote";
export { usePanelData } from "./panels/usePanelData";
export { PanelCard, PanelMessage } from "./panels/PanelCard";
export {
  SessionsTableView,
  PointerHeatmapCanvas,
  ViewDirectionHeatmapCanvas,
  PerfSummaryStats,
} from "./panels/views";
export { SessionsPanel } from "./panels/SessionsPanel";
export { PointerHeatmapPanel } from "./panels/PointerHeatmapPanel";
export { ViewDirectionHeatmapPanel } from "./panels/ViewDirectionHeatmapPanel";
export { PerformanceSummaryPanel } from "./panels/PerformanceSummaryPanel";

// --- Portable OSS panel catalog (ADR 0036 / ADR 0047). ----------------------
// `ossPanelCatalog` is the complete, portable set of built-in analytics panels
// so a downstream host can enumerate and render every OSS panel from this
// package alone. Each panel is also exported individually for cherry-picking.
// The Babylon-backed 3D panels are code-split (React.lazy inside the catalog),
// so importing the catalog never loads `@babylonjs/*` at module-eval time — the
// core entry stays Babylon-free and tree-shakeable (`sideEffects: false`).
export {
  ossPanelCatalog,
  topMeshesPanel,
  meshLeaderboardPanel,
  blindSpotsPanel,
  variantLeaderboardPanel,
  pointerHeatmapPanel,
  meshUvHeatmapPanel,
  cameraDomePanel,
  viewCoveragePanel,
  floorPlanPanel,
  desireLinesPanel,
  meshKindsPanel,
  reachabilityPanel,
  inputModalityPanel,
  renderScalePanel,
  perfDistributionPanel,
  perfChurnPanel,
  placementFunnelPanel,
  worldHeatmapPanel,
  perfHeatmapPanel,
  errorHeatmapPanel,
  navigationMixPanel,
  xrLocomotionComfortPanel,
  trackingQualityPanel,
  sceneRetentionPanel,
  backtrackPanel,
  deadZonePanel,
  flowPanel,
  divergencePanel,
  loadBounceFunnelPanel,
  livePresencePanel,
  sessionReplayPanel,
} from "./catalog/ossPanelCatalog";

// --- Panel view components (2D / HTML / canvas — Babylon-free). --------------
// The panel BODIES used by the catalog. Hosts can compose these directly (the
// host owns the surrounding chrome; a view renders the body only).
export { HeatLegend } from "./catalog/views/HeatLegend";
export { ZoomButtons } from "./catalog/views/ZoomButtons";
export { FloorPlanHeatmapView } from "./catalog/views/FloorPlanHeatmap";
export { DesireLinesView } from "./catalog/views/DesireLines";
export { MeshInteractionKindsView } from "./catalog/views/MeshInteractionKinds";
export { ReachabilityView, summarizeReachability } from "./catalog/views/Reachability";
export { MeshLeaderboardView, buildLeaderboard } from "./catalog/views/MeshLeaderboard";
export { InputModalitySplitView, buildModalitySplit } from "./catalog/views/InputModalitySplit";
export { DeadZoneReportView, buildDeadZones } from "./catalog/views/DeadZoneReport";
export { PerfDistributionView } from "./catalog/views/PerfDistribution";
export { ViewCoverageView } from "./catalog/views/ViewCoverage";
export { PerfChurnView } from "./catalog/views/PerfChurn";
export { RenderScaleTruthView } from "./catalog/views/RenderScaleTruth";
export { NavigationMixView } from "./catalog/views/NavigationMix";
export {
  XrLocomotionComfortView,
  locomotionMix,
  comfortCorrelation,
  sessionDurationMs,
} from "./catalog/views/XrLocomotionComfort";
export { TrackingQualityView, trackingSummary } from "./catalog/views/TrackingQuality";
export { SceneRetentionFunnelView } from "./catalog/views/SceneRetentionFunnel";
export { LoadBounceFunnelView, LOAD_BANDS } from "./catalog/views/LoadBounceFunnel";
export { PointerHeatmapView } from "./catalog/views/PointerHeatmap";
export { TopMeshesView } from "./catalog/views/TopMeshes";
export { BlindSpotReportView } from "./catalog/views/BlindSpotReport";
export {
  LivePresenceView,
  LIVE_PRESENCE_TITLE,
  LIVE_PRESENCE_SUBTITLE,
  LIVE_PRESENCE_HELP,
} from "./catalog/views/LivePresence";

// --- 3D / canvas helper libs (Babylon-free at module-eval; ADR 0014/0037). --
// The panels' shared 3D helpers. Babylon is only referenced via type-only
// imports (elided) or dynamic `import()` inside effects, so these are safe to
// import from the core entry without pulling in `@babylonjs/*`.
export {
  attachDoubleClickFocus,
  resetFocus,
  disableWheelZoom,
  stepZoom,
  ZOOM_IN_FACTOR,
  ZOOM_OUT_FACTOR,
} from "./catalog/lib/orbitZoom";
export type { OrbitZoomCamera, OrbitFocusCamera, OrbitHome } from "./catalog/lib/orbitZoom";
export { attachMeshHover } from "./catalog/lib/sceneHover";
export type { HoverTip } from "./catalog/lib/sceneHover";
export { mergeSceneProxies } from "./catalog/lib/sceneProxies";
export {
  OTHER_STANDPOINT,
  OTHER_MESH,
  voxelKey,
  buildTwoStageGraph,
} from "./catalog/lib/flowGraph";
export type {
  FlowStandpoint,
  TwoStageKind,
  TwoStageNode,
  TwoStageRibbon,
  TwoStageGraph,
  TwoStageCaps,
} from "./catalog/lib/flowGraph";
