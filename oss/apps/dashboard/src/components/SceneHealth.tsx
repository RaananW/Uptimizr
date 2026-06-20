"use client";

import type { EventTypeCount, PerfSummary } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

/** A single health metric tile. */
function Stat({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  hint?: string;
}) {
  const toneClass =
    tone === "bad"
      ? "text-red-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "good"
          ? "text-emerald-300"
          : "text-fg-hi";
  return (
    <div className="rounded-lg border border-edge bg-ink/40 px-3 py-2.5">
      <p className="text-xs uppercase tracking-wide text-fg-muted">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {hint ? <p className="text-[11px] text-fg-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * Scene-health overview derived from per-event-type counts (Issue 1 lifecycle &
 * error events) plus the perf summary: error rate, GPU context-loss incidents,
 * attention gaps (focus/visibility), and resize churn.
 */
export function SceneHealth({
  counts,
  perf,
}: {
  counts: EventTypeCount[];
  perf: PerfSummary | null;
}) {
  const by = new Map(counts.map((c) => [c.event_type, c.count]));
  const get = (t: string) => by.get(t) ?? 0;

  const sessions = get("session_start");
  const errors = get("runtime_error");
  const contextLost = get("context_lost");
  const blurGaps = get("focus_change");
  const visibilityGaps = get("visibility_change");
  const resizes = get("viewport_resize");
  const total = counts.reduce((s, c) => s + c.count, 0);

  const errorsPerSession = sessions > 0 ? errors / sessions : 0;
  const hasData = total > 0;

  return (
    <Panel
      title="Scene health"
      subtitle="Errors, GPU context loss & attention gaps in the selected window"
    >
      {!hasData ? (
        <p className="text-sm text-fg-muted">No events in range.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat
            label="Errors"
            value={formatNumber(errors)}
            tone={errors > 0 ? "bad" : "good"}
            hint={sessions > 0 ? `${errorsPerSession.toFixed(2)} / session` : undefined}
          />
          <Stat
            label="Context loss"
            value={formatNumber(contextLost)}
            tone={contextLost > 0 ? "warn" : "good"}
            hint="GPU device lost"
          />
          <Stat
            label="Avg FPS"
            value={perf && perf.samples > 0 ? formatNumber(perf.avg_fps, 1) : "—"}
            tone={perf && perf.samples > 0 ? (perf.avg_fps >= 50 ? "good" : "warn") : "neutral"}
            hint={perf && perf.samples > 0 ? `min ${formatNumber(perf.min_fps, 0)}` : undefined}
          />
          <Stat label="Sessions" value={formatNumber(sessions)} />
          <Stat
            label="Attention"
            value={formatNumber(blurGaps + visibilityGaps)}
            hint="focus + visibility changes"
          />
          <Stat label="Resizes" value={formatNumber(resizes)} hint="viewport changes" />
        </div>
      )}
    </Panel>
  );
}
