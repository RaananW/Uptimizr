import type {
  ArPlacementAttemptsBin,
  ArPlacementSurfaceRow,
  ArPlacementTimeToPlaceBin,
} from "../../api";
import type { ReactNode } from "react";
import { formatNumber } from "../../format";

export const PLACEMENT_FUNNEL_TITLE = "AR placement funnel";
export const PLACEMENT_FUNNEL_SUBTITLE = "How hard was it to place the object in the room?";
export const PLACEMENT_FUNNEL_HELP =
  'The friction of AR "view in your room" placement (#156, ADR 0048). Time-to-place is how long each object took to settle onto a surface, bucketed; re-placement counts how many tries (attempts) each settle needed — a hesitation signal; the surface breakdown shows which coarse surface class (floor / wall / table / ceiling / unknown) objects landed on and the average final scale (1 = authored real-world size). Signals are coarse and on-device only per ADR 0003 — no room geometry, images, or precise coordinates leave the client. One row per placement settle, not per frame.';

/** All three placement-funnel reads, loaded together for one panel. */
export interface PlacementFunnelData {
  timeToPlace: ArPlacementTimeToPlaceBin[];
  attempts: ArPlacementAttemptsBin[];
  surfaces: ArPlacementSurfaceRow[];
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-xs uppercase tracking-wide text-fg-muted">{children}</div>;
}

/** Horizontal bar histogram of time-to-place, in seconds (one bar per ms bucket). */
function TimeToPlaceHistogram({ bins }: { bins: ArPlacementTimeToPlaceBin[] }) {
  if (bins.length === 0) {
    return <p className="text-sm text-fg-muted">No placements in range.</p>;
  }
  const sorted = [...bins].sort((a, b) => a.bucket - b.bucket);
  const max = sorted.reduce((m, b) => Math.max(m, b.placements), 0) || 1;
  // Infer the bin width from the first two buckets (builder default is 2000 ms).
  const width = sorted.length > 1 ? sorted[1]!.bucket - sorted[0]!.bucket : 2000;
  return (
    <div className="space-y-1.5">
      {sorted.map((b) => (
        <div key={b.bucket} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 text-right tabular-nums text-fg-muted">
            {formatNumber(b.bucket / 1000, 1)}–{formatNumber((b.bucket + width) / 1000, 1)}s
          </span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-ink/60">
            <div
              className="h-full rounded bg-sky-500/70"
              style={{ width: `${(b.placements / max) * 100}%` }}
            />
          </div>
          <span className="w-10 shrink-0 tabular-nums text-fg-muted">{b.placements}</span>
        </div>
      ))}
    </div>
  );
}

/** Horizontal bar distribution of re-placement attempts (1 try, 2 tries, …). */
function AttemptsDistribution({ bins }: { bins: ArPlacementAttemptsBin[] }) {
  if (bins.length === 0) {
    return <p className="text-sm text-fg-muted">No placements in range.</p>;
  }
  const sorted = [...bins].sort((a, b) => a.attempts - b.attempts);
  const max = sorted.reduce((m, b) => Math.max(m, b.placements), 0) || 1;
  return (
    <div className="space-y-1.5">
      {sorted.map((b) => (
        <div key={b.attempts} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 text-right tabular-nums text-fg-muted">
            {b.attempts} {b.attempts === 1 ? "try" : "tries"}
          </span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-ink/60">
            <div
              className="h-full rounded bg-violet-500/70"
              style={{ width: `${(b.placements / max) * 100}%` }}
            />
          </div>
          <span className="w-10 shrink-0 tabular-nums text-fg-muted">{b.placements}</span>
        </div>
      ))}
    </div>
  );
}

/** Surface-class breakdown: placement count + average final scale per surface. */
function SurfaceBreakdown({ rows }: { rows: ArPlacementSurfaceRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-fg-muted">No placements in range.</p>;
  }
  const sorted = [...rows].sort((a, b) => b.placements - a.placements);
  const max = sorted.reduce((m, r) => Math.max(m, r.placements), 0) || 1;
  return (
    <div className="space-y-1.5">
      {sorted.map((r) => (
        <div key={r.surface} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 text-right capitalize text-fg-muted">{r.surface}</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-ink/60">
            <div
              className="h-full rounded bg-emerald-500/70"
              style={{ width: `${(r.placements / max) * 100}%` }}
            />
          </div>
          <span className="w-10 shrink-0 tabular-nums text-fg-muted">{r.placements}</span>
          <span className="w-16 shrink-0 text-right tabular-nums text-fg-muted">
            ×{formatNumber(r.avg_scale, 2)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * AR placement funnel (#156, ADR 0048): time-to-place distribution, re-placement
 * (attempts) distribution, and coarse surface breakdown for retail "view in your
 * room" flows. Panel BODY only; the host supplies the chrome via the ADR 0036
 * panel contract. Wraps the three `arPlacement*` reads — no client state.
 */
export function PlacementFunnelView({ data }: { data: PlacementFunnelData | null }) {
  const timeToPlace = data?.timeToPlace ?? [];
  const attempts = data?.attempts ?? [];
  const surfaces = data?.surfaces ?? [];
  const total = surfaces.reduce((s, r) => s + r.placements, 0);
  if (total === 0 && timeToPlace.length === 0 && attempts.length === 0) {
    return <p className="text-sm text-fg-muted">No AR placements in range.</p>;
  }
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <SectionLabel>Time to place</SectionLabel>
        <TimeToPlaceHistogram bins={timeToPlace} />
      </div>
      <div className="space-y-1.5">
        <SectionLabel>Re-placement attempts</SectionLabel>
        <AttemptsDistribution bins={attempts} />
      </div>
      <div className="space-y-1.5">
        <SectionLabel>Surface breakdown (× avg scale)</SectionLabel>
        <SurfaceBreakdown rows={surfaces} />
      </div>
    </div>
  );
}
