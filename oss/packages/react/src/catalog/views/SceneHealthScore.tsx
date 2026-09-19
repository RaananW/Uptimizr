"use client";

import type { SceneHealthFactor, SceneHealthScore } from "../../api";
import { formatNumber } from "../../format";

export const SCENE_HEALTH_SCORE_TITLE = "Scene health score";
export const SCENE_HEALTH_SCORE_SUBTITLE =
  "0-100 against this project's preceding window — 50 is the project norm";
export const SCENE_HEALTH_SCORE_HELP =
  "The `insight_scene_health` primitive (ADR 0051 §4): six weighted factors — perf stability, jank, error rate, dead clicks, exploration coverage and XR abandonment — each normalised against the project's own baseline over the preceding equal window, combined into one weighted mean. The score is a comparison, not a grade: 50 means this scene is doing exactly as well as the rest of the project did last week, so a project where every scene is equally bad reads 50 everywhere. Hover a factor to see the metric id behind it, the raw value it produced and the baseline it was compared with. A factor with no bar could not be measured in this window and was left out of the mean.";

/** Below this the score is coloured as a problem, above it as healthy. */
const WARN_BELOW = 45;
const GOOD_ABOVE = 60;

/** Tailwind text colour for a 0-100 score. */
function toneFor(score: number | null): string {
  if (score == null) return "text-fg-muted";
  if (score < WARN_BELOW) return "text-red-300";
  if (score < GOOD_ABOVE) return "text-amber-300";
  return "text-emerald-300";
}

/** Tailwind fill for a factor bar, on the same thresholds as the headline. */
function fillFor(score: number | null): string {
  if (score == null) return "bg-fg-muted/30";
  if (score < WARN_BELOW) return "bg-red-400/70";
  if (score < GOOD_ABOVE) return "bg-amber-400/70";
  return "bg-emerald-400/70";
}

/** `perf_stability` → `perf stability`. The ids are the API's, the labels are not. */
function humanise(id: string): string {
  return id.replace(/_/g, " ");
}

/**
 * The one-line explanation behind a factor, used as the bar's tooltip.
 *
 * Deliberately names the **metric id**, not a prose paraphrase: the point of the
 * tile is that a reader can go from a short bar to the endpoint that explains
 * it without guessing which one that is.
 */
function tooltipFor(factor: SceneHealthFactor): string {
  const reading =
    factor.raw == null
      ? "no value in this window"
      : `${formatNumber(factor.raw, 2)} ${factor.unit}`;
  const against =
    factor.baseline == null
      ? "no project baseline"
      : `project baseline ${formatNumber(factor.baseline, 2)} ${factor.unit}`;
  const weight = `weight ${formatNumber(factor.weight * 100, 0)}%`;
  return `${factor.metric}: ${reading} (${against}, ${weight})\n${factor.note}`;
}

/** One factor bar: name, normalised score, and the metric behind it on hover. */
function FactorBar({ factor }: { factor: SceneHealthFactor }) {
  const width = factor.score == null ? 0 : Math.max(2, factor.score);
  return (
    <div
      className="flex items-center gap-2 text-xs"
      title={tooltipFor(factor)}
      data-testid={`health-factor-${factor.id}`}
      data-metric={factor.metric}
    >
      <span className="w-28 shrink-0 truncate text-right text-fg-muted">{humanise(factor.id)}</span>
      <div className="h-3 flex-1 overflow-hidden rounded bg-ink/60">
        <div className={`h-full rounded ${fillFor(factor.score)}`} style={{ width: `${width}%` }} />
      </div>
      <span className="w-10 shrink-0 tabular-nums text-fg-muted">
        {factor.score == null ? "—" : formatNumber(factor.score, 0)}
      </span>
    </div>
  );
}

/** One scene: its headline score and the factor bars that produced it. */
function SceneRow({ row }: { row: SceneHealthScore }) {
  return (
    <div
      className="rounded-lg border border-edge bg-ink/40 p-3"
      data-testid="scene-health-row"
      data-scene={row.scene}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-sm font-medium text-fg-hi">
          {row.scene === "" ? "All scenes" : row.scene}
        </p>
        <p
          className={`shrink-0 text-2xl font-semibold tabular-nums ${toneFor(row.score)}`}
          data-testid="scene-health-score"
        >
          {row.score == null ? "—" : formatNumber(row.score, 0)}
        </p>
      </div>
      <p className="mt-0.5 text-[11px] text-fg-muted">
        {formatNumber(row.sampleSize, 0)} sessions
        {row.sampleSize > 0 && row.sampleSize < 20 ? " — too few to read confidently" : ""}
      </p>
      <div className="mt-2 space-y-1">
        {row.factors.map((factor) => (
          <FactorBar key={factor.id} factor={factor} />
        ))}
      </div>
    </div>
  );
}

/**
 * Scene-health score tile (#307, ADR 0051 §4). Panel BODY only — the host
 * supplies the chrome through the ADR 0036 panel contract.
 *
 * Renders the rows exactly as the endpoint ranks them (least healthy first) and
 * keeps every factor visible, including the ones that could not be scored: a
 * missing factor is information about the data, and hiding it would make the
 * headline look better supported than it is.
 */
export function SceneHealthScoreView({ rows }: { rows: SceneHealthScore[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-fg-muted">No scenes with data in range.</p>;
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="scene-health-score">
      {rows.map((row) => (
        <SceneRow key={row.scene} row={row} />
      ))}
    </div>
  );
}
