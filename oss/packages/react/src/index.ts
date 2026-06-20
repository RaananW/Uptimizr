// @uptimizr/react — embeddable React analytics panels for the Uptimizr collector.
//
// Wrap your app in <UptimizrProvider endpoint apiKey> and drop in any panel.
// Panels read the collector query API through the shared CollectorApi client
// (browser → query API only; never the database — ADR 0004).

export * from "./api";
export { heatRgb, HEAT_GRADIENT } from "./heat";
export { heatColor, formatNumber, formatTime, parseTimestamp } from "./format";
export { drawPointerHeatmap, drawDirectionHeatmap, HEATMAP_BACKGROUND } from "./draw";
export { UptimizrProvider, useUptimizr, useCollectorApi } from "./provider";
export { useAsync } from "./useAsync";
export type { AsyncState } from "./useAsync";
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
