import type { BoundaryContactStat } from "../../api";
import { formatNumber } from "../../format";

/**
 * Guardian/boundary contacts (#157, ADR 0048) — the panel BODY only (no chrome).
 * A room-scale comfort signal for XR developers: how often headsets approached
 * their play-space boundary and how long they lingered in the near-boundary
 * zone. Built from `xr_boundary_proximity` events (one per approach), each of
 * which carries only a coarse on-device position + duration — the boundary
 * polygon and room geometry are never captured or transmitted (ADR 0003).
 *
 * Frequent contact means the physical space didn't comfortably fit the
 * experience; a companion to the VR locomotion comfort panel.
 */

/** How many top sessions the per-session list shows before truncating. */
const TOP_SESSIONS = 8;

/** Scene-wide boundary-contact rollup across sessions. */
export interface BoundaryContactSummary {
  /** Number of sessions that approached the boundary at least once. */
  sessions: number;
  /** Total near-boundary approaches across all sessions. */
  contacts: number;
  /** Total time spent in the near-boundary zone across all sessions, in ms. */
  nearMs: number;
}

/** Sum the per-session boundary contacts into a scene-wide summary. */
export function summarizeBoundaryContacts(stats: BoundaryContactStat[]): BoundaryContactSummary {
  let contacts = 0;
  let nearMs = 0;
  for (const s of stats) {
    contacts += s.contacts;
    nearMs += s.near_ms;
  }
  return { sessions: stats.length, contacts, nearMs };
}

/** Compact duration label: sub-minute as `x.x s`, otherwise `x.x min`. */
function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

/** Shorten a session id to its first 8 chars for a compact table row. */
function shortSession(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function BoundaryContactsView({ stats }: { stats: BoundaryContactStat[] }) {
  const summary = summarizeBoundaryContacts(stats);

  if (stats.length === 0 || summary.contacts === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No guardian-boundary approaches in range. This panel reads{" "}
        <code>xr_boundary_proximity</code> events, emitted on-device when a headset nears its
        play-space boundary — enter a room-scale session to populate it. The boundary shape is never
        captured; only a coarse position and duration per approach.
      </p>
    );
  }

  const ranked = [...stats].sort((a, b) => b.contacts - a.contacts);
  const top = ranked.slice(0, TOP_SESSIONS);
  const avgPerSession = summary.contacts / Math.max(summary.sessions, 1);

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-fg-muted">Contacts</dt>
          <dd className="tabular-nums font-medium text-fg">{formatNumber(summary.contacts)}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Sessions</dt>
          <dd className="tabular-nums font-medium text-fg">{formatNumber(summary.sessions)}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Avg / session</dt>
          <dd className="tabular-nums font-medium text-fg">{formatNumber(avgPerSession, 1)}</dd>
        </div>
      </dl>

      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-fg-muted">
            <th className="text-left font-normal">Session</th>
            <th className="text-right font-normal">Contacts</th>
            <th className="text-right font-normal">Near time</th>
          </tr>
        </thead>
        <tbody>
          {top.map((s) => (
            <tr key={s.session_id}>
              <td className="py-0.5 font-mono text-fg">{shortSession(s.session_id)}</td>
              <td className="py-0.5 text-right text-fg-muted">{formatNumber(s.contacts)}</td>
              <td className="py-0.5 text-right text-fg-muted">{formatSpan(s.near_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-fg-muted">
        Frequent boundary contact means the physical play space didn&apos;t comfortably fit the
        experience. Only the on-device outcome (position + duration) is sent — never the boundary
        shape or room size.
      </p>
    </div>
  );
}

export const BOUNDARY_CONTACTS_TITLE = "Guardian boundary contacts";
export const BOUNDARY_CONTACTS_SUBTITLE =
  "Per-session near-boundary approaches + time in the guardian zone — a room-scale comfort signal";
