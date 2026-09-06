"use client";

import { useEffect, useMemo, useRef } from "react";
import type { TrajectoryPoint } from "../../api";
import { heatColor } from "../../format";
import {
  HEIGHT_FLAT_THRESHOLD,
  formatHeight,
  heightEncodingActive,
  heightRange,
  heightT,
} from "../lib/trajectoryHeight";
import { HeatLegend } from "./HeatLegend";

const SIZE = 360;
const PAD = 16;

// Canvas can't read the host theme, so these mirror the dashboard tokens.
const CANVAS_BG = "#0b0e14";
const MARKER_START = "#9bb23e"; // --color-success
const MARKER_END = "#d64533"; // --color-error
const MARKER_RING = "#f4eadf"; // --color-fg-hi
/** Routes drawn without height use the middle of the ramp so they don't read as "lowest". */
const FLAT_STROKE = heatColor(0.5);

export const WALKED_PATH_TITLE = "Walked path";
export const WALKED_PATH_SUBTITLE = "Camera trajectory (top-down)";
export const WALKED_PATH_HELP =
  "The ordered route this session's camera took across the X/Z ground plane — green is the start, red is the end. The line color follows camera height: rust is the lowest point on the route, saffron the highest, so stairs, ramps, lifts, and floor changes stand out. Meaningful for first-person (walkable) sessions.";

/**
 * Top-down walked-path view for a single session (ADR 0026): the ordered
 * `camera_sample` positions projected onto the X/Z ground plane and connected
 * oldest→newest, with start (green) and end (red) markers. The first-person
 * analog of the session pointer heatmap — it shows the route a visitor took
 * through a walkable scene.
 *
 * Height (world Y) is encoded as the path color (#92): each segment is tinted
 * on the shared Ember heat ramp from the lowest point on the route (rust) to
 * the highest (saffron), so ramps, stairs, lifts, and multi-floor routes read
 * in plan view instead of looking like adjacent points on one floor. A legend
 * shows the actual low/high heights. Routes whose height barely varies (below
 * {@link HEIGHT_FLAT_THRESHOLD}) are drawn in a single color and say so.
 * `colorByHeight={false}` turns the encoding off (a viewer setting).
 *
 * Panel BODY only (no chrome); the host supplies title/subtitle/help via the
 * ADR 0036 panel contract.
 */
export function WalkedPathView({
  points,
  colorByHeight = true,
}: {
  points: TrajectoryPoint[];
  /** Encode camera height as the line color (default on). */
  colorByHeight?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  const range = useMemo(() => heightRange(points), [points]);
  /** The height range to encode, or `null` when off or the route is (near-)level. */
  const encoded = colorByHeight && heightEncodingActive(range) ? range : null;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, SIZE, SIZE);

    if (points.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const span = Math.max(maxX - minX, maxZ - minZ, 1e-3);
    const scale = (SIZE - PAD * 2) / span;
    // Project world (x, z) → canvas (px, py); flip Z so smaller world Z is up.
    const project = (p: TrajectoryPoint): [number, number] => [
      PAD + (p.x - minX) * scale,
      PAD + (maxZ - p.z) * scale,
    ];

    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (encoded) {
      // One stroke per segment, tinted by the segment's mean height. Round caps
      // hide the seams so the polyline still reads as one continuous route.
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        const [ax, ay] = project(a);
        const [bx, by] = project(b);
        ctx.strokeStyle = heatColor(heightT((a.y + b.y) / 2, encoded));
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = FLAT_STROKE;
      ctx.beginPath();
      points.forEach((p, i) => {
        const [px, py] = project(p);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // Start/end markers get a light ring so they stay distinct from the rust
    // (low) end of the height ramp.
    const marker = (p: TrajectoryPoint, fill: string) => {
      const [x, y] = project(p);
      ctx.fillStyle = fill;
      ctx.strokeStyle = MARKER_RING;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    const first = points[0];
    const last = points[points.length - 1];
    if (first) marker(first, MARKER_START);
    if (last) marker(last, MARKER_END);
  }, [points, encoded]);

  return (
    <>
      <div className="flex justify-center">
        <div className="relative inline-block">
          <canvas
            ref={ref}
            width={SIZE}
            height={SIZE}
            className="rounded-lg border border-edge"
            aria-label="Session camera trajectory, colored by camera height"
          />
          {encoded ? (
            <HeatLegend
              title="Camera height"
              lowLabel={formatHeight(encoded.min)}
              highLabel={formatHeight(encoded.max)}
              note="Line color = height along the route (brighter is higher)."
            />
          ) : null}
        </div>
      </div>
      {points.length === 0 ? (
        <p className="mt-2 text-center text-xs text-fg-muted">
          No camera movement recorded for this session.
        </p>
      ) : colorByHeight && !encoded ? (
        <p className="mt-2 text-center text-xs text-fg-muted">
          Level route — camera height varied by less than {formatHeight(HEIGHT_FLAT_THRESHOLD)}
          {range ? ` (around ${formatHeight(range.min)})` : ""}.
        </p>
      ) : null}
    </>
  );
}
