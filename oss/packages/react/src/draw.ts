// Shared canvas painters for the 2D pointer heatmap and the polar
// view-direction heatmap. Both the standalone dashboard and the embeddable
// `@uptimizr/react` panels draw through these functions, so there is one
// implementation of each heatmap rendering, not two.

import type { DirectionBin, HeatmapBin } from "./api";
import { heatColor } from "./format";

/** Background fill shared by the heatmap canvases (matches the brand UI ink). */
export const HEATMAP_BACKGROUND = "#161210";

/**
 * Paint a 2D pointer heatmap. Screen-normalized positions are binned into a
 * `gridSize x gridSize` grid server-side; here we paint per-cell intensities
 * over a `size x size` canvas (CSS pixels; set the transform before calling).
 */
export function drawPointerHeatmap(
  ctx: CanvasRenderingContext2D,
  bins: HeatmapBin[],
  gridSize: number,
  size: number,
): void {
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = HEATMAP_BACKGROUND;
  ctx.fillRect(0, 0, size, size);

  if (bins.length === 0) return;

  const max = bins.reduce((m, b) => Math.max(m, b.count), 0);
  const cell = size / gridSize;
  for (const b of bins) {
    const t = max > 0 ? b.count / max : 0;
    ctx.fillStyle = heatColor(t, 0.85);
    ctx.fillRect(b.gx * cell, b.gy * cell, Math.ceil(cell), Math.ceil(cell));
  }
}

/**
 * Paint a view-direction heatmap as a polar (top-down) projection on a
 * `size x size` canvas: azimuth maps to the angle around the disc, elevation to
 * radius (straight up at the center, straight down at the rim). Draws the
 * sphere outline, horizon ring, heat cells, and the up/horizon/down axis guides.
 */
export function drawDirectionHeatmap(
  ctx: CanvasRenderingContext2D,
  bins: DirectionBin[],
  gridSize: number,
  size: number,
): void {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 18;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = HEATMAP_BACKGROUND;
  ctx.fillRect(0, 0, size, size);

  // Sphere outline + horizon ring.
  ctx.strokeStyle = "#34291f";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, radius / 2, 0, Math.PI * 2);
  ctx.stroke();

  if (bins.length > 0) {
    const max = bins.reduce((m, b) => Math.max(m, b.count), 0);
    const azStep = (Math.PI * 2) / gridSize;

    for (const b of bins) {
      const t = max > 0 ? b.count / max : 0;
      // elevation_bin: 0 = straight down (rim), gridSize = straight up (center).
      const elevInner = 1 - (b.elevation_bin + 1) / gridSize;
      const elevOuter = 1 - b.elevation_bin / gridSize;
      const rInner = Math.max(0, elevInner) * radius;
      const rOuter = Math.max(0, elevOuter) * radius;
      const a0 = b.azimuth_bin * azStep;
      const a1 = a0 + azStep;

      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, a0, a1);
      ctx.arc(cx, cy, rInner, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = heatColor(t, 0.85);
      ctx.fill();
    }
  }

  // Orientation guides: a vertical tick axis from the center (looking up) out to
  // the rim (looking down), with the horizon at the mid-ring. Drawn last, with a
  // dark halo, so the elevation meaning is readable over the heat.
  const label = (text: string, x: number, y: number) => {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(22,18,16,0.9)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "#d8c8b8";
    ctx.fillText(text, x, y);
  };

  ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  ctx.strokeStyle = "rgba(203,213,225,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - radius);
  ctx.stroke();
  for (const r of [0, radius / 2, radius]) {
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy - r);
    ctx.lineTo(cx + 3, cy - r);
    ctx.stroke();
  }

  label("up", cx + 6, cy);
  label("horizon", cx + 6, cy - radius / 2);
  label("down", cx + 6, cy - radius + 2);
}
