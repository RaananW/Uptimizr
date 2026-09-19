"use client";

import { lazy, Suspense, type ReactNode } from "react";
import type { PanelChartKind, PanelEncoding } from "@uptimizr/schema";
import type { HeatmapBin, WorldHeatmapBin } from "../../api";
import { formatNumber } from "../../format";
import { PointerHeatmapView } from "./PointerHeatmap";
import { TopMeshesView } from "./TopMeshes";

/**
 * The renderer behind `specPanel()` (#315, ADR 0051 §7 / sketch §G.3): one view
 * that draws any {@link PanelChartKind} from the rows a DSL query returned.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a **dispatcher**, not a chart library. The drawings that already exist
 * in this catalog are reused as they are — `bar` is the mesh leaderboard's bar
 * list, `heatmap2d` is the pointer-heatmap canvas, `world3d` is the world
 * heatmap's Babylon view (still lazily loaded, so a spec panel costs nothing in
 * Babylon until one is actually drawn). No new canvas, no new 3D scene, no
 * second way of painting a heatmap.
 *
 * The four that have no existing generic primitive — `stat`, `table`, `line`
 * and `area` — are drawn here, minimally and in one place, because every
 * catalog panel that shows a number or a series does so over its own typed row
 * shape (`PerfSummary`, `TimeseriesBucket`, `MeshCount`) and none of them can
 * take `Record<string, unknown>[]`. A spec panel's rows are only known at
 * request time, so something has to bridge that, and one small module is a
 * better answer than seven bespoke ones.
 *
 * ## Rows are untrusted
 *
 * The rows come from a metric chosen by a spec that an agent wrote, so nothing
 * here assumes a column exists or holds the type it should. Every projection
 * goes through {@link cell}, missing values render as an em dash rather than
 * `undefined`, and an empty result is a sentence rather than a blank panel.
 */

/** One result row: a DSL query's shape is only known at request time. */
export type SpecRow = Record<string, unknown>;

/**
 * The world-heatmap 3D view, code-split exactly as the OSS catalog splits it —
 * a spec panel must not pull `@babylonjs/*` into the static import graph of
 * this package's core entry.
 */
const WorldHeatmap3DLazy = lazy(() =>
  import("../views3d/WorldHeatmap3D").then((m) => ({ default: m.WorldHeatmap3DView })),
);

function Lazy3D({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-[12rem] place-items-center text-sm text-fg-muted">
          Loading 3D view…
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

/** "Nothing in range" — the honest empty state, never a blank panel. */
function Empty({ children = "No data in range." }: { children?: ReactNode }) {
  return <p className="text-sm text-fg-muted">{children}</p>;
}

/** Read one column of a row as a display string. */
function cell(row: SpecRow, column: string | undefined): string {
  if (column == null) return "—";
  const value = row[column];
  if (value == null) return "—";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return JSON.stringify(value);
}

/** Read one column of a row as a number, defaulting to 0. */
function num(row: SpecRow, column: string | undefined): number {
  if (column == null) return 0;
  const value = row[column];
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

/** The column names present across the result, in first-row order. */
function columnsOf(rows: readonly SpecRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

/** One number, big — for a metric whose result *is* one row. */
function StatView({ rows, encoding }: { rows: readonly SpecRow[]; encoding: PanelEncoding }) {
  const row = rows[0];
  if (row == null) return <Empty />;
  // With no `y` named, fall back to the first numeric column: a single-record
  // metric that declares no measure still has a number worth showing.
  const column =
    encoding.y ?? Object.keys(row).find((key) => typeof row[key] === "number") ?? undefined;
  return (
    <div>
      <div className="text-3xl font-semibold tabular-nums text-fg">{cell(row, column)}</div>
      {column != null ? <div className="mt-1 text-xs text-fg-muted">{column}</div> : null}
    </div>
  );
}

/** The rows as they came — the fallback that can draw any metric. */
function TableView({ rows, encoding }: { rows: readonly SpecRow[]; encoding: PanelEncoding }) {
  if (rows.length === 0) return <Empty />;
  // An encoding narrows the table to the columns the spec cared about; without
  // one, every column is shown.
  const named = [encoding.x, encoding.series, encoding.y].filter(
    (column): column is string => column != null,
  );
  const columns = named.length > 0 ? named : columnsOf(rows);
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="text-[11px] uppercase text-fg-muted">
            {columns.map((column) => (
              <th key={column} className="px-2.5 py-1.5 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-edge">
              {columns.map((column) => (
                <td key={column} className="px-2.5 py-1.5 tabular-nums text-fg">
                  {cell(row, column)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A ranked list of labelled bars — the mesh leaderboard's own view, fed the
 * spec's chosen label and measure columns.
 */
function BarView({ rows, encoding }: { rows: readonly SpecRow[]; encoding: PanelEncoding }) {
  return (
    <TopMeshesView
      meshes={rows.map((row) => ({
        mesh: cell(row, encoding.x),
        count: num(row, encoding.y),
      }))}
    />
  );
}

/** Plot geometry for the series views. Matches the event-volume strip's shape. */
const HEIGHT = 150;
const PAD = { top: 12, right: 12, bottom: 20, left: 44 };

/**
 * A measure walked along an ordered axis, as an SVG polyline (`line`) or the
 * same line over a filled area (`area`).
 *
 * SVG rather than a canvas so the panel is server-renderable and testable
 * without a DOM canvas — the existing canvas views exist because they paint
 * thousands of bins, which a bucketed series never is.
 */
function SeriesView({
  rows,
  encoding,
  filled,
}: {
  rows: readonly SpecRow[];
  encoding: PanelEncoding;
  filled: boolean;
}) {
  if (rows.length === 0) return <Empty />;
  const values = rows.map((row) => num(row, encoding.y));
  const max = values.reduce((m, v) => Math.max(m, v), 0);
  const width = 640;
  const plot = {
    x: PAD.left,
    y: PAD.top,
    w: width - PAD.left - PAD.right,
    h: HEIGHT - PAD.top - PAD.bottom,
  };
  // One point is a dot, not a line: divide by `length - 1` only when there is
  // more than one, so a single-bucket result does not produce NaN coordinates.
  const step = values.length > 1 ? plot.w / (values.length - 1) : 0;
  const points = values.map((value, index) => {
    const x = plot.x + index * step;
    const y = plot.y + plot.h - (max > 0 ? (value / max) * plot.h : 0);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `${plot.x},${plot.y + plot.h} ${points.join(" ")} ${(
    plot.x +
    step * (values.length - 1)
  ).toFixed(1)},${plot.y + plot.h}`;

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={`${encoding.y ?? "value"} over ${encoding.x ?? "the axis"}`}
      >
        {filled ? <polygon points={area} className="fill-amber/20" /> : null}
        <polyline
          points={points.join(" ")}
          className="fill-none stroke-amber"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </svg>
      <div className="flex justify-between text-[11px] text-fg-muted">
        <span>{cell(rows[0]!, encoding.x)}</span>
        <span>{cell(rows[rows.length - 1]!, encoding.x)}</span>
      </div>
    </div>
  );
}

/**
 * The bin-grid columns every `bin`-grain metric projects. Fixed rather than
 * encoding-driven: the 2D canvas paints a grid addressed by `(gx, gy)`, and a
 * spec cannot rename what the metric already returns.
 */
function toHeatmapBins(rows: readonly SpecRow[]): HeatmapBin[] {
  return rows.map((row) => ({
    gx: num(row, "gx"),
    gy: num(row, "gy"),
    count: num(row, "count"),
  }));
}

/** The voxel columns every `voxel`-grain metric projects. */
function toVoxels(rows: readonly SpecRow[]): WorldHeatmapBin[] {
  return rows.map((row) => ({
    vx: num(row, "vx"),
    vy: num(row, "vy"),
    vz: num(row, "vz"),
    count: num(row, "count"),
  }));
}

/**
 * Grid resolution for a spec's 2D heatmap. The canvas needs to know how many
 * bins a side the metric produced; a spec's `filters.bins` says when it was
 * pinned, and the widest bin index in the result is the honest fallback.
 */
function gridSizeFor(rows: readonly SpecRow[], bins: number | undefined): number {
  if (bins != null && bins > 0) return bins;
  const widest = rows.reduce((m, row) => Math.max(m, num(row, "gx"), num(row, "gy")), 0);
  return Math.max(1, widest + 1);
}

/** Voxel size for a spec's 3D heatmap; the metric's own default when unpinned. */
const DEFAULT_CELL_SIZE = 0.5;

export interface SpecChartProps {
  chart: PanelChartKind;
  rows: readonly SpecRow[];
  /** Which column feeds which channel — already defaulted from the metric. */
  encoding: PanelEncoding;
  /** The spec's `filters.bins`, when it pinned one (2D heatmaps). */
  bins?: number;
  /** The spec's `filters.cellSize`, when it pinned one (3D heatmaps). */
  cellSize?: number;
}

/** Draw one chart kind over one result. The panel BODY only — no chrome. */
export function SpecChart({ chart, rows, encoding, bins, cellSize }: SpecChartProps): ReactNode {
  switch (chart) {
    case "stat":
      return <StatView rows={rows} encoding={encoding} />;
    case "bar":
      return rows.length === 0 ? <Empty /> : <BarView rows={rows} encoding={encoding} />;
    case "line":
      return <SeriesView rows={rows} encoding={encoding} filled={false} />;
    case "area":
      return <SeriesView rows={rows} encoding={encoding} filled />;
    case "heatmap2d":
      return rows.length === 0 ? (
        <Empty />
      ) : (
        <PointerHeatmapView bins={toHeatmapBins(rows)} gridSize={gridSizeFor(rows, bins)} />
      );
    case "world3d":
      return rows.length === 0 ? (
        <Empty>No 3D hit-points in range.</Empty>
      ) : (
        <Lazy3D>
          <WorldHeatmap3DLazy
            voxels={toVoxels(rows)}
            cellSize={cellSize ?? DEFAULT_CELL_SIZE}
            legendTitle="Density"
            legendNote="Each marker is one cell of this metric's world-space grid. Color and size scale with the cell's value, normalized to the 95th-percentile cell."
          />
        </Lazy3D>
      );
    case "table":
    default:
      return <TableView rows={rows} encoding={encoding} />;
  }
}
