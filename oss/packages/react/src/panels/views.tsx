"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { DirectionBin, HeatmapBin, PerfSummary, SessionSummary } from "../api";
import { drawDirectionHeatmap, drawPointerHeatmap } from "../draw";
import { formatNumber, formatTime } from "../format";

// Presentational panel *content* — the single source of each panel's rendering.
// These take already-fetched data as props (no card chrome, no data fetching) so
// the embeddable self-fetching panels AND the standalone dashboard render the
// exact same markup. Change a panel's look here once; both update.

const muted: CSSProperties = { fontSize: 13, color: "#a8917c" };
const cellBase: CSSProperties = {
  padding: "6px 10px",
  fontSize: 13,
  borderTop: "1px solid #34291f",
};

/** The sessions table (or empty state). Rows are clickable when `onSelect` is set. */
export function SessionsTableView({
  sessions,
  onSelect,
  selectedId,
}: {
  sessions: SessionSummary[];
  onSelect?: (sessionId: string) => void;
  selectedId?: string;
}) {
  if (sessions.length === 0) return <p style={muted}>No sessions in range.</p>;
  return (
    <div style={{ maxHeight: 320, overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
        <thead>
          <tr style={{ fontSize: 11, textTransform: "uppercase", color: "#a8917c" }}>
            <th style={{ padding: "6px 10px" }}>Session</th>
            <th style={{ padding: "6px 10px" }}>Visitor</th>
            <th style={{ padding: "6px 10px", textAlign: "right" }}>Events</th>
            <th style={{ padding: "6px 10px" }}>Started</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const active = s.session_id === selectedId;
            return (
              <tr
                key={s.session_id}
                onClick={onSelect ? () => onSelect(s.session_id) : undefined}
                style={{
                  cursor: onSelect ? "pointer" : "default",
                  background: active ? "rgba(237,166,62,0.15)" : undefined,
                }}
              >
                <td
                  style={{ ...cellBase, fontFamily: "ui-monospace, monospace", color: "#d8c8b8" }}
                >
                  {s.session_id.slice(0, 12)}
                </td>
                <td
                  style={{ ...cellBase, fontFamily: "ui-monospace, monospace", color: "#a8917c" }}
                >
                  {s.visitor_id.slice(0, 8)}
                </td>
                <td style={{ ...cellBase, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {formatNumber(s.events)}
                </td>
                <td style={{ ...cellBase, fontSize: 12, color: "#a8917c" }}>
                  {formatTime(s.started_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 2D pointer heatmap `<canvas>` (no chrome). Paints via the shared
 * {@link drawPointerHeatmap}. `className`/`style` decorate the canvas element.
 */
export function PointerHeatmapCanvas({
  bins,
  gridSize,
  size = 320,
  className,
  style,
}: {
  bins: HeatmapBin[];
  gridSize: number;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawPointerHeatmap(ctx, bins, gridSize, size);
  }, [bins, gridSize, size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      className={className}
      style={style}
      aria-label="Pointer heatmap"
    />
  );
}

/**
 * Polar view-direction heatmap `<canvas>` (no chrome). Paints via the shared
 * {@link drawDirectionHeatmap} at device-pixel resolution. CSS size is `size`
 * (overridable through `style`); `className` decorates the canvas element.
 */
export function ViewDirectionHeatmapCanvas({
  bins,
  gridSize,
  size = 340,
  className,
  style,
}: {
  bins: DirectionBin[];
  gridSize: number;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawDirectionHeatmap(ctx, bins, gridSize, size);
  }, [bins, gridSize, size]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width: size, height: size, ...style }}
      aria-label="Camera view-direction heatmap: top-down polar plot where the center is looking up, the middle ring is the horizon, and the rim is looking down; color shows how often each direction was viewed."
    />
  );
}

const statCard: CSSProperties = { background: "rgba(32,25,19,0.6)", borderRadius: 8, padding: 12 };
const statLabel: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "#a8917c",
};
const statValue: CSSProperties = {
  marginTop: 4,
  fontSize: 24,
  fontWeight: 600,
  color: "#f4eadf",
  fontVariantNumeric: "tabular-nums",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statCard}>
      <div style={statLabel}>{label}</div>
      <div style={statValue}>{value}</div>
    </div>
  );
}

/** The rendering-performance stat grid (or empty state). */
export function PerfSummaryStats({ perf }: { perf: PerfSummary | null }) {
  if (!perf || perf.samples === 0) {
    return <p style={muted}>No performance samples in range.</p>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
      <Stat label="Samples" value={formatNumber(perf.samples)} />
      <Stat label="Avg FPS" value={formatNumber(perf.avg_fps, 1)} />
      <Stat label="p50 FPS" value={formatNumber(perf.p50_fps, 1)} />
      <Stat label="Min FPS" value={formatNumber(perf.min_fps, 1)} />
    </div>
  );
}
