"use client";

import type { DirectionBin, QueryParams } from "../api";
import { useCollectorApi } from "../provider";
import { useAsync } from "../useAsync";
import { PanelCard, PanelMessage } from "./PanelCard";
import { ViewDirectionHeatmapCanvas } from "./views";

/**
 * View-direction heatmap on an abstract sphere (polar top-down projection):
 * center = looking up, rim = looking down. Self-fetching; renders the shared
 * {@link ViewDirectionHeatmapCanvas}.
 */
export function ViewDirectionHeatmapPanel({
  params,
  gridSize = 24,
}: {
  params?: QueryParams;
  /** Grid resolution; must match the `bins` requested from the query API. */
  gridSize?: number;
}) {
  const api = useCollectorApi();
  const key = JSON.stringify(params ?? {});
  const { data, loading, error } = useAsync<DirectionBin[]>(
    () => api.cameraHeatmap({ bins: gridSize, ...params }),
    [api, key, gridSize],
  );

  return (
    <PanelCard
      title="View-direction heatmap"
      subtitle="Top-down sphere — center = looking up, rim = looking down"
    >
      {loading ? (
        <PanelMessage>Loading…</PanelMessage>
      ) : error ? (
        <PanelMessage>Could not load heatmap: {error.message}</PanelMessage>
      ) : (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <ViewDirectionHeatmapCanvas
            bins={data ?? []}
            gridSize={gridSize}
            style={{ borderRadius: 8, border: "1px solid #34291f" }}
          />
        </div>
      )}
    </PanelCard>
  );
}
