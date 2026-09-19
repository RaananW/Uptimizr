"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationRow, TimeseriesBucket } from "../../api";

const HEIGHT = 150;
const PAD = { top: 14, right: 36, bottom: 22, left: 40 };

export const EVENT_VOLUME_TITLE = "Event volume over time";
export const EVENT_VOLUME_SUBTITLE = "Bars: events per bucket · drag to zoom the time window";

/** Human-friendly label for a bucket interval (e.g. 60000 → "1m", 3600000 → "1h"). */
export function formatBucket(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
  return `${ms}ms`;
}

/**
 * Event-volume time-series strip — the 4th dimension. Bars show event volume per
 * bucket. Drag horizontally to brush a range, which becomes the global
 * `since`/`until` (release to apply). This is what turns an all-time average into
 * a trustworthy, time-aware view. (FPS is intentionally not plotted here — a
 * wall-clock mean across mixed devices/sessions is misleading; see the
 * dedicated performance panels for per-session, device-aware FPS.)
 *
 * Panel BODY only (no chrome); the host supplies title/subtitle via the
 * ADR 0036 panel contract and the brush/clear callbacks via `ctx.actions`.
 */
export function VolumeTimeseriesView({
  buckets,
  intervalMs,
  onBrush,
  onClear,
  brushed,
  annotations = [],
}: {
  buckets: TimeseriesBucket[];
  intervalMs: number;
  onBrush: (since: number, until: number) => void;
  onClear?: () => void;
  /** Whether a custom brushed range is currently applied (shows a Clear action). */
  brushed?: boolean;
  /**
   * Project annotations to mark on the time axis (#310, ADR 0051 §5) — "v2.1
   * shipped", "the outage". Only those carrying a `since` can be placed; a
   * standing note about the project as a whole has no position on a time axis
   * and is left to the annotation list elsewhere.
   */
  annotations?: readonly AnnotationRow[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(640);
  const dragRef = useRef<{ x0: number; x1: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

  // Track the container width so the canvas fills the panel responsively.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.max(320, el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plot = {
    x: PAD.left,
    y: PAD.top,
    w: Math.max(1, width - PAD.left - PAD.right),
    h: HEIGHT - PAD.top - PAD.bottom,
  };

  // Time span covered by the strip (start of first bucket → end of last bucket).
  const span =
    buckets.length > 0
      ? {
          start: buckets[0]!.bucket,
          end: buckets[buckets.length - 1]!.bucket + intervalMs,
        }
      : null;

  const xToTime = useCallback(
    (px: number): number => {
      if (!span) return 0;
      const t = (px - plot.x) / plot.w;
      return Math.round(span.start + Math.max(0, Math.min(1, t)) * (span.end - span.start));
    },
    [span, plot.x, plot.w],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, HEIGHT);
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, width, HEIGHT);

    if (buckets.length === 0 || !span) {
      ctx.fillStyle = "#64748b";
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No events in range", width / 2, HEIGHT / 2);
      return;
    }

    const maxEvents = buckets.reduce((m, b) => Math.max(m, b.events), 0) || 1;
    const spanMs = span.end - span.start;
    const barW = Math.max(1, (plot.w / buckets.length) * 0.8);

    // Event-volume bars.
    for (const b of buckets) {
      const cx = plot.x + ((b.bucket - span.start) / spanMs) * plot.w;
      const bh = (b.events / maxEvents) * plot.h;
      ctx.fillStyle = "rgba(56, 189, 248, 0.55)";
      ctx.fillRect(cx, plot.y + plot.h - bh, barW, bh);
    }

    // Axis ticks & units: left = events/bucket (sky).
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(56, 189, 248, 0.95)";
    ctx.textAlign = "right";
    ctx.fillText(String(maxEvents), plot.x - 5, plot.y + 4);
    ctx.fillText("0", plot.x - 5, plot.y + plot.h);
    // Axis caption along the bottom edge.
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(56, 189, 248, 0.7)";
    ctx.textAlign = "left";
    ctx.fillText(`events / ${formatBucket(intervalMs)}`, plot.x, HEIGHT - 6);

    // Brush overlay.
    if (drag) {
      const x0 = Math.min(drag.x0, drag.x1);
      const x1 = Math.max(drag.x0, drag.x1);
      ctx.fillStyle = "rgba(56, 189, 248, 0.18)";
      ctx.fillRect(x0, plot.y, x1 - x0, plot.h);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.8)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, plot.y, x1 - x0, plot.h);
    }
  }, [buckets, width, span, drag, intervalMs, plot.x, plot.y, plot.w, plot.h]);

  const onDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    dragRef.current = { x0: x, x1: x };
    setDrag({ x0: x, x1: x });
  };
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const next = { ...dragRef.current, x1: e.clientX - rect.left };
    dragRef.current = next;
    setDrag(next);
  };
  const onUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || Math.abs(d.x1 - d.x0) < 4) return; // ignore clicks
    const a = xToTime(Math.min(d.x0, d.x1));
    const b = xToTime(Math.max(d.x0, d.x1));
    if (b > a) onBrush(a, b);
  };

  // Annotation markers (#310): a small tick above the strip at the note's
  // `since`, with the note itself as the tooltip. They are DOM elements rather
  // than canvas drawing so each one carries a real, accessible tooltip — and
  // because a marker is a label about the chart, not part of the data in it.
  // Standing notes with no timestamp are skipped — there is nowhere honest to
  // put them — and so are notes whose whole period falls outside the plotted
  // span. A note that *overlaps* the span is kept and placed at its start,
  // clamped into view: a note about the whole window still belongs on it, and
  // the strip's span is the buckets with data, not the requested range.
  const markers = span
    ? annotations
        .map((annotation) => ({
          annotation,
          at: annotation.since == null ? Number.NaN : Date.parse(annotation.since),
          end: annotation.until == null ? Number.NaN : Date.parse(annotation.until),
        }))
        .filter(({ at, end }) => {
          if (!Number.isFinite(at) || at > span.end) return false;
          // An open-ended note ends where it starts, so a one-moment note before
          // the span is still excluded.
          return (Number.isFinite(end) ? end : at) >= span.start;
        })
        .map(({ annotation, at }) => ({
          annotation,
          // Percentage, so the marker tracks the canvas as it resizes.
          left:
            Math.min(1, Math.max(0, (at - span.start) / Math.max(1, span.end - span.start))) * 100,
        }))
    : [];

  return (
    <div ref={wrapRef} className="relative">
      <canvas
        ref={canvasRef}
        width={width}
        height={HEIGHT}
        className="w-full cursor-crosshair rounded-lg border border-edge"
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
        aria-label="Event volume time series"
      />
      {markers.length > 0 && (
        <ul
          className="pointer-events-none absolute inset-x-0 top-0"
          aria-label="Annotations"
          data-role="annotation-markers"
        >
          {markers.map(({ annotation, left }) => (
            <li
              key={annotation.id}
              className="pointer-events-auto absolute"
              style={{
                left: `calc(${PAD.left}px + (100% - ${PAD.left + PAD.right}px) * ${left / 100})`,
                top: 2,
              }}
              data-role="annotation-marker"
              data-annotation-id={annotation.id}
            >
              <span
                title={annotation.text}
                aria-label={annotation.text}
                className="block h-2 w-2 -translate-x-1/2 rotate-45 border border-amber bg-amber/70"
              />
            </li>
          ))}
        </ul>
      )}
      {brushed && onClear ? (
        <button
          type="button"
          onClick={onClear}
          className="absolute right-2 top-2 rounded-md border border-edge bg-ink/80 px-2 py-1 text-xs text-fg transition hover:border-amber hover:text-fg-hi"
        >
          Clear zoom
        </button>
      ) : null}
    </div>
  );
}
