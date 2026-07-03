// @uptimizr/react — embeddable React analytics panels for the Uptimizr collector.
//
// Wrap your app in <UptimizrProvider endpoint apiKey> and drop in any panel.
// Panels read the collector query API through the shared CollectorApi client
// (browser → query API only; never the database — ADR 0004).

export * from "./api";
export { heatRgb, HEAT_GRADIENT, percentileMax } from "./heat";
export { heatColor, formatNumber, formatTime, parseTimestamp } from "./format";
export { drawPointerHeatmap, drawDirectionHeatmap, HEATMAP_BACKGROUND } from "./draw";
export { UptimizrProvider, useUptimizr, useCollectorApi } from "./provider";
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
export type { LiveEvent } from "./live";

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
