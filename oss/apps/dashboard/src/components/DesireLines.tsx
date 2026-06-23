"use client";

import { useEffect, useRef } from "react";
import type { AggregateTrajectoryPoint } from "@/lib/api";
import { Panel } from "./Panel";

const SIZE = 360;
const PAD = 8;

export const DESIRE_LINES_TITLE = "Desire lines";
export const DESIRE_LINES_SUBTITLE = "The routes visitors actually walk";
export const DESIRE_LINES_HELP =
  "Every session's camera path, binned onto the ground plane and overlaid as a faint poly-line. Where many visitors walk the same way the lines pile up into bright 'desire lines' — the routes people take vs. the ones the scene intended. Filter to the first-person camera mode to isolate walkable sessions.";

interface SessionPath {
  cells: { gx: number; gz: number }[];
}

/**
 * Group ordered points by session and dedupe consecutive identical cells so a
 * stationary camera doesn't pile up zero-length segments.
 */
function groupSessions(points: AggregateTrajectoryPoint[]): SessionPath[] {
  const bySession = new Map<string, { gx: number; gz: number }[]>();
  for (const p of points) {
    let cells = bySession.get(p.session_id);
    if (!cells) {
      cells = [];
      bySession.set(p.session_id, cells);
    }
    const last = cells[cells.length - 1];
    if (!last || last.gx !== p.gx || last.gz !== p.gz) cells.push({ gx: p.gx, gz: p.gz });
  }
  return [...bySession.values()].map((cells) => ({ cells }));
}

/**
 * Aggregate desire lines (#73, ADR 0037): one low-opacity poly-line per session
 * over an auto-fit top-down floor plan, drawn additively so overlapping routes
 * self-reinforce into bright desire lines. Panel BODY only (no chrome); the host
 * supplies title/subtitle/help via the ADR 0036 panel contract.
 */
export function DesireLinesView({ points }: { points: AggregateTrajectoryPoint[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, SIZE, SIZE);
    if (points.length === 0) return;

    // Auto-fit the occupied cell bounding box (cells can be negative; walkable
    // scenes are not centered on the origin).
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
      if (p.gx < minX) minX = p.gx;
      if (p.gx > maxX) maxX = p.gx;
      if (p.gz < minZ) minZ = p.gz;
      if (p.gz > maxZ) maxZ = p.gz;
    }
    const span = Math.max(maxX - minX + 1, maxZ - minZ + 1);
    const cell = (SIZE - PAD * 2) / span;
    const toPx = (gx: number, gz: number): [number, number] => [
      PAD + (gx - minX + 0.5) * cell,
      // Flip Z so "north" (smaller world Z) is at the top of the plan.
      PAD + (maxZ - gz + 0.5) * cell,
    ];

    const sessions = groupSessions(points);
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // Additive low-opacity strokes: overlapping routes self-reinforce into bright
    // desire lines while sparse detours stay faint.
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = "rgba(251, 191, 36, 0.18)";
    for (const s of sessions) {
      if (s.cells.length < 2) continue;
      ctx.beginPath();
      const [x0, y0] = toPx(s.cells[0]!.gx, s.cells[0]!.gz);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < s.cells.length; i++) {
        const [x, y] = toPx(s.cells[i]!.gx, s.cells[i]!.gz);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }, [points]);

  return (
    <>
      <div className="flex justify-center">
        <canvas
          ref={ref}
          width={SIZE}
          height={SIZE}
          className="rounded-lg border border-edge"
          aria-label="Aggregate desire-line paths"
        />
      </div>
      {points.length === 0 ? (
        <p className="mt-2 text-center text-xs text-fg-muted">
          No camera-path data in range. Capture first-person sessions to populate the desire lines.
        </p>
      ) : null}
    </>
  );
}

/** Chrome-wrapped desire lines for legacy call sites. */
export function DesireLines({ points }: { points: AggregateTrajectoryPoint[] }) {
  return (
    <Panel title={DESIRE_LINES_TITLE} subtitle={DESIRE_LINES_SUBTITLE} help={DESIRE_LINES_HELP}>
      <DesireLinesView points={points} />
    </Panel>
  );
}
