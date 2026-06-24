import type { FpsHistogramBin, PerfDistribution } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

export const PERF_DISTRIBUTION_TITLE = "Performance distribution";
export const PERF_DISTRIBUTION_SUBTITLE = "p05 / p50 / p95 FPS bands, not just the average";
export const PERF_DISTRIBUTION_HELP =
  "The shape of rendering performance, not a single average: p05 (worst), p50 (typical) and p95 (best) FPS computed per-session then aggregated (ADR 0028 §1), plus a histogram of per-session median FPS. One session contributes one data point, so a few chatty sessions can't skew the curve.";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-ink/60 p-3">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-fg-hi">{value}</div>
    </div>
  );
}

/** Horizontal bar histogram of per-session median FPS (one session = one count). */
function FpsHistogram({ bins }: { bins: FpsHistogramBin[] }) {
  if (bins.length === 0) {
    return <p className="text-sm text-fg-muted">No FPS samples in range.</p>;
  }
  const sorted = [...bins].sort((a, b) => a.bucket - b.bucket);
  const max = sorted.reduce((m, b) => Math.max(m, b.sessions), 0) || 1;
  // Infer the bin width from the first two buckets (builder default is 10).
  const width = sorted.length > 1 ? sorted[1]!.bucket - sorted[0]!.bucket : 10;
  return (
    <div className="space-y-1.5">
      {sorted.map((b) => (
        <div key={b.bucket} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 text-right tabular-nums text-fg-muted">
            {b.bucket}–{b.bucket + width}
          </span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-ink/60">
            <div
              className="h-full rounded bg-emerald-500/70"
              style={{ width: `${(b.sessions / max) * 100}%` }}
            />
          </div>
          <span className="w-10 shrink-0 tabular-nums text-fg-muted">{b.sessions}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Performance distribution histogram (#77, ADR 0028 §1): the p05/p50/p95 FPS
 * bands and a per-session median-FPS histogram, as a reusable panel. No new
 * aggregation — wraps the existing `perfDistribution` + `fpsHistogram` reads.
 * Panel BODY only; the host supplies the chrome via the ADR 0036 panel contract.
 */
export function PerfDistributionView({
  distribution,
  histogram,
}: {
  distribution: PerfDistribution | null;
  histogram: FpsHistogramBin[];
}) {
  if (!distribution || distribution.samples === 0) {
    return <p className="text-sm text-fg-muted">No performance samples in range.</p>;
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="p05 FPS (worst)" value={formatNumber(distribution.p05_fps, 1)} />
        <Stat label="p50 FPS (typical)" value={formatNumber(distribution.p50_fps, 1)} />
        <Stat label="p95 FPS (best)" value={formatNumber(distribution.p95_fps, 1)} />
        <Stat label="Sessions" value={formatNumber(distribution.sessions)} />
      </div>
      <FpsHistogram bins={histogram} />
    </div>
  );
}

/** Chrome-wrapped performance distribution for legacy call sites. */
export function PerfDistributionPanel({
  distribution,
  histogram,
}: {
  distribution: PerfDistribution | null;
  histogram: FpsHistogramBin[];
}) {
  return (
    <Panel
      title={PERF_DISTRIBUTION_TITLE}
      subtitle={PERF_DISTRIBUTION_SUBTITLE}
      help={PERF_DISTRIBUTION_HELP}
    >
      <PerfDistributionView distribution={distribution} histogram={histogram} />
    </Panel>
  );
}
