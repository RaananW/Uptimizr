"use client";

import type { HeatmapBin } from "../../api";
import { PointerHeatmapCanvas } from "../../panels/views";

/**
 * 2D pointer-heatmap panel body. The canvas rendering is the shared
 * {@link PointerHeatmapCanvas}; this view only centers it (the host supplies the
 * panel chrome via the ADR 0036 contract).
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
