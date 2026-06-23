"use client";

import type { HeatmapBin } from "@/lib/api";
import { PointerHeatmapCanvas } from "@uptimizr/react";
import { Panel } from "./Panel";

/**
 * 2D pointer heatmap. The canvas rendering is the shared
 * {@link PointerHeatmapCanvas} from `@uptimizr/react`; this component only adds
 * the dashboard panel chrome around it.
 */
export function PointerHeatmapView({ bins, gridSize }: { bins: HeatmapBin[]; gridSize: number }) {
  return (
    <div className="flex justify-center">
      <PointerHeatmapCanvas
        bins={bins}
        gridSize={gridSize}
        className="rounded-lg border border-edge"
      />
    </div>
  );
}

export const POINTER_HEATMAP_TITLE = "Pointer heatmap";
export const POINTER_HEATMAP_SUBTITLE = "Normalized screen positions";

/** Chrome-wrapped pointer heatmap for legacy call sites (overview + session surfaces). */
export function PointerHeatmap({ bins, gridSize }: { bins: HeatmapBin[]; gridSize: number }) {
  return (
    <Panel title={POINTER_HEATMAP_TITLE} subtitle={POINTER_HEATMAP_SUBTITLE}>
      <PointerHeatmapView bins={bins} gridSize={gridSize} />
    </Panel>
  );
}
