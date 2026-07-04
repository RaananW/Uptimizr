import type { ViewCoverageBin } from "../../api";
import { formatNumber } from "../../format";

export const VIEW_COVERAGE_TITLE = "View coverage";
export const VIEW_COVERAGE_SUBTITLE = "How much of the object each session actually saw";
export const VIEW_COVERAGE_HELP =
  "The 360° coverage gauge (#146): for each session, its camera view-direction samples are binned into the same azimuth/elevation grid as the view-direction dome, and the fraction of cells it visited is its coverage score (0–100%). Sessions are grouped into four coverage bands, so you can read at a glance how many visitors barely looked around (<25%) versus explored the whole object (75–100%). Derived entirely from existing camera samples — no extra capture.";

/** The four fixed coverage bands, keyed by the bucket's inclusive lower bound (percent). */
const BANDS: { bucket: number; label: string }[] = [
  { bucket: 0, label: "0–25%" },
  { bucket: 25, label: "25–50%" },
  { bucket: 50, label: "50–75%" },
  { bucket: 75, label: "75–100%" },
];

/**
 * 360° view-coverage histogram (#146). One session contributes one data point,
 * bucketed by the fraction of the object it looked at. The four bands are always
 * rendered (zero-count bands included) so the gauge reads consistently, and a
 * headline calls out the share of sessions that saw less than a quarter of the
 * object — the "did they really check it out?" number. Panel BODY only; the host
 * supplies the chrome via the ADR 0036 panel contract.
 */
export function ViewCoverageView({ bins }: { bins: ViewCoverageBin[] }) {
  const counts = new Map(bins.map((b) => [b.bucket, b.sessions]));
  const rows = BANDS.map((band) => ({ ...band, sessions: counts.get(band.bucket) ?? 0 }));
  const total = rows.reduce((sum, r) => sum + r.sessions, 0);

  if (total === 0) {
    return <p className="text-sm text-fg-muted">No view-direction samples in range.</p>;
  }

  const max = rows.reduce((m, r) => Math.max(m, r.sessions), 0) || 1;
  const lowShare = (counts.get(0) ?? 0) / total;

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-ink/60 p-3">
        <div className="text-xs uppercase tracking-wide text-fg-muted">
          Sessions that saw &lt;25% of the object
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-fg-hi">
          {formatNumber(lowShare * 100, 0)}%
        </div>
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.bucket} className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 text-right tabular-nums text-fg-muted">{r.label}</span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-ink/60">
              <div
                className="h-full rounded bg-emerald-500/70"
                style={{ width: `${(r.sessions / max) * 100}%` }}
              />
            </div>
            <span className="w-10 shrink-0 tabular-nums text-fg-muted">{r.sessions}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
