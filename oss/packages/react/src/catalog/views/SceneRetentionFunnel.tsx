import type { SceneRetentionLink } from "../../api";
import { formatNumber } from "../../format";

export const SCENE_RETENTION_TITLE = "Scene retention funnel";
export const SCENE_RETENTION_SUBTITLE = "How sessions flow between scenes/levels";
export const SCENE_RETENTION_HELP =
  "Canned level-retention preset (#147): session counts flowing scene → scene in the order they occur, built directly from scene_change markers — no funnel steps to author. Each row is a consecutive transition weighted by the distinct sessions that made it; grouping by the scene left shows where visitors go next and where they drop off. Complements the caller-authored funnel (ADR 0038).";

/** Bar colour for the retained flow (matches the interaction-kinds ramp). */
const BAR_COLOR = "#34d399";

interface SceneGroup {
  from: string;
  /** Total distinct-session transitions leaving this scene (sum of exits). */
  outgoing: number;
  /** The busiest single exit — the retention baseline the others read against. */
  top: number;
  links: { to: string; sessions: number }[];
}

/**
 * Group links by their source scene, busiest source first, and within each
 * source order the exits by session count. `top` is the busiest exit, used to
 * scale the bars so the dominant path fills the row and thinner paths read as
 * drop-off.
 */
function groupByScene(links: SceneRetentionLink[]): SceneGroup[] {
  const byFrom = new Map<string, SceneGroup>();
  for (const l of links) {
    let g = byFrom.get(l.from);
    if (!g) {
      g = { from: l.from, outgoing: 0, top: 0, links: [] };
      byFrom.set(l.from, g);
    }
    g.links.push({ to: l.to, sessions: l.sessions });
    g.outgoing += l.sessions;
    g.top = Math.max(g.top, l.sessions);
  }
  const groups = [...byFrom.values()].sort((a, b) => b.outgoing - a.outgoing);
  for (const g of groups) g.links.sort((a, b) => b.sessions - a.sessions);
  return groups;
}

/**
 * Scene/level retention funnel (#147): per source scene, the outgoing
 * scene → scene transitions as bars weighted by distinct sessions, so
 * level-to-level drop-off is visible with zero configuration. Panel BODY only
 * (no chrome); the host supplies title/subtitle/help via the ADR 0036 contract.
 */
export function SceneRetentionFunnelView({ links }: { links: SceneRetentionLink[] }) {
  const groups = groupByScene(links);
  if (groups.length === 0) {
    return (
      <p className="text-sm text-fg-muted" data-testid="scene-retention-empty">
        No scene transitions in range. Sessions need at least two scene_change markers to form a
        flow.
      </p>
    );
  }
  return (
    <ul className="space-y-4" data-testid="scene-retention-funnel">
      {groups.map((g) => (
        <li key={g.from} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate font-mono text-xs text-fg" title={g.from}>
              {g.from}
            </span>
            <span className="tabular-nums text-xs text-fg-muted">
              {formatNumber(g.outgoing)} leaving
            </span>
          </div>
          <ul className="space-y-1">
            {g.links.map((l) => {
              const pct = g.top > 0 ? (l.sessions / g.top) * 100 : 0;
              return (
                <li key={l.to} className="text-sm" data-scene-link={`${g.from}->${l.to}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs text-fg-muted">→ {l.to}</span>
                    <span className="tabular-nums text-fg-muted">{formatNumber(l.sessions)}</span>
                  </div>
                  <div className="mt-0.5 h-2 w-full overflow-hidden rounded bg-ink/60">
                    <div
                      className="h-full"
                      style={{ width: `${pct}%`, backgroundColor: BAR_COLOR }}
                      title={`${g.from} → ${l.to}: ${formatNumber(l.sessions)} sessions`}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
