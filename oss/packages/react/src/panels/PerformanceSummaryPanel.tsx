"use client";

import type { PerfSummary, QueryParams } from "../api";
import { useCollectorApi } from "../provider";
import { useAsync } from "../useAsync";
import { PanelCard, PanelMessage } from "./PanelCard";
import { PerfSummaryStats } from "./views";

/**
 * Rendering-performance summary (samples + avg/p50/min FPS) over the range.
 * Self-fetching; renders the shared {@link PerfSummaryStats} view.
 */
export function PerformanceSummaryPanel({ params }: { params?: QueryParams }) {
  const api = useCollectorApi();
  const key = JSON.stringify(params ?? {});
  const { data, loading, error } = useAsync<PerfSummary>(() => api.perf(params), [api, key]);

  return (
    <PanelCard title="Rendering performance" subtitle="frame_perf samples">
      {loading ? (
        <PanelMessage>Loading…</PanelMessage>
      ) : error ? (
        <PanelMessage>Could not load performance: {error.message}</PanelMessage>
      ) : (
        <PerfSummaryStats perf={data} />
      )}
    </PanelCard>
  );
}
