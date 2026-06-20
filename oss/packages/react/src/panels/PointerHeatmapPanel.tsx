"use client";

import type { HeatmapBin, QueryParams } from "../api";
import { useCollectorApi } from "../provider";
import { useAsync } from "../useAsync";
import { PanelCard, PanelMessage } from "./PanelCard";
import { PointerHeatmapCanvas } from "./views";

/**
 * 2D pointer heatmap of normalized screen positions. Self-fetching; renders the
 * shared {@link PointerHeatmapCanvas} so the dashboard and embeds match.
 */
export function PointerHeatmapPanel({
  params,
  gridSize = 32,
}: {
  params?: QueryParams;
  /** Grid resolution; must match the `bins` requested from the query API. */
  gridSize?: number;
}) {
  const api = useCollectorApi();
  const key = JSON.stringify(params ?? {});
  const { data, loading, error } = useAsync<HeatmapBin[]>(
    () => api.pointerHeatmap({ bins: gridSize, ...params }),
    [api, key, gridSize],
  );

  return (
    <PanelCard title="Pointer heatmap" subtitle="Normalized screen positions">
      {loading ? (
        <PanelMessage>Loading…</PanelMessage>
      ) : error ? (
        <PanelMessage>Could not load heatmap: {error.message}</PanelMessage>
      ) : (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <PointerHeatmapCanvas
            bins={data ?? []}
            gridSize={gridSize}
            style={{ borderRadius: 8, border: "1px solid #34291f" }}
          />
        </div>
      )}
    </PanelCard>
  );
}
