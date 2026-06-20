"use client";

import { Panel } from "@/components/Panel";
import { formatNumber } from "@/lib/format";
import type { PresenceSnapshot, PresenceRosterItem } from "@/lib/api";
import type { LiveEvent, LiveStatus } from "@/lib/live";

/** A short, human-scannable id (first 8 chars) for a session/event row. */
function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/** "12s ago" / "3m ago" relative label from an epoch-ms timestamp. */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const ACTIVITY_DOT: Record<PresenceRosterItem["activity"], string> = {
  active: "bg-emerald-400",
  recent: "bg-amber-400",
  idle: "bg-fg-muted",
};

const STATUS_LABEL: Record<LiveStatus, string> = {
  idle: "offline",
  connecting: "connecting…",
  open: "live",
  reconnecting: "reconnecting…",
};

/** A pulsing badge summarizing the live connection + active counts. */
function LiveBadge({ status, sessions }: { status: LiveStatus; sessions: number }) {
  const live = status === "open";
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-edge bg-ink px-3 py-1 text-xs">
      <span className="relative flex h-2 w-2">
        {live ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        ) : null}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${
            live ? "bg-emerald-400" : status === "idle" ? "bg-fg-muted" : "bg-amber-400"
          }`}
        />
      </span>
      <span className="font-medium text-fg">
        {live ? `${formatNumber(sessions)} live now` : STATUS_LABEL[status]}
      </span>
    </span>
  );
}

/**
 * Real-time presence panel (ADR 0032 §3): the "N live now" badge, the
 * non-identifying active-session roster, and a rolling feed of arriving events.
 * Purely presentational — the page owns the SSE connections and feeds props in.
 */
export function LivePresence({
  snapshot,
  status,
  feed,
  now,
  onSelectSession,
}: {
  snapshot: PresenceSnapshot | null;
  status: LiveStatus;
  feed: LiveEvent[];
  /** A periodically-updated clock so relative times stay fresh (epoch ms). */
  now: number;
  /** Open a session's live drill-down (powers live replay — ADR 0032 §4). */
  onSelectSession?: (sessionId: string) => void;
}) {
  const roster = snapshot?.sessions ?? [];
  const activeSessions = snapshot?.activeSessions ?? 0;
  const activeVisitors = snapshot?.activeVisitors ?? 0;

  return (
    <Panel
      title="Live now"
      subtitle="Active sessions and a real-time event feed, updating in place."
      help={
        <>
          Sessions seen within the liveness window, streamed over SSE from the collector. The
          roster is intentionally non-identifying — no geo, user-agent, or visitor id. Click a
          session to follow it live.
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <LiveBadge status={status} sessions={activeSessions} />
        <span className="text-xs text-fg-muted">
          <span className="font-semibold text-fg">{formatNumber(activeVisitors)}</span>{" "}
          visitor{activeVisitors === 1 ? "" : "s"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Roster */}
        <div>
          <p className="mb-2 text-xs uppercase tracking-wide text-fg-muted">
            Sessions ({roster.length})
          </p>
          {roster.length === 0 ? (
            <p className="text-sm text-fg-muted">
              {status === "open" ? "No active sessions right now." : "Waiting for live data…"}
            </p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
              {roster.map((s) => (
                <li key={s.sessionId}>
                  {onSelectSession ? (
                    <button
                      type="button"
                      onClick={() => onSelectSession(s.sessionId)}
                      className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition hover:border-edge hover:bg-ink"
                    >
                      <span
                        className={`h-2 w-2 flex-none rounded-full ${ACTIVITY_DOT[s.activity]}`}
                        aria-hidden="true"
                      />
                      <span className="font-mono text-xs text-fg">
                        {shortId(s.sessionId)}
                      </span>
                      <span className="truncate text-xs text-fg-muted">{s.sceneId}</span>
                      <span className="ml-auto flex-none text-xs text-fg-muted">
                        {ago(s.lastSeen, now)}
                      </span>
                    </button>
                  ) : (
                    <div className="flex w-full items-center gap-2 px-2 py-1.5">
                      <span
                        className={`h-2 w-2 flex-none rounded-full ${ACTIVITY_DOT[s.activity]}`}
                        aria-hidden="true"
                      />
                      <span className="font-mono text-xs text-fg">
                        {shortId(s.sessionId)}
                      </span>
                      <span className="truncate text-xs text-fg-muted">{s.sceneId}</span>
                      <span className="ml-auto flex-none text-xs text-fg-muted">
                        {ago(s.lastSeen, now)}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Live event feed */}
        <div>
          <p className="mb-2 text-xs uppercase tracking-wide text-fg-muted">Event feed</p>
          {feed.length === 0 ? (
            <p className="text-sm text-fg-muted">
              {status === "open" ? "Listening for events…" : "Waiting for live data…"}
            </p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1 font-mono text-xs">
              {feed.map((e, i) => (
                <li
                  key={`${e.sessionId}-${e.ts}-${i}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1"
                >
                  <span className="flex-none rounded bg-amber/15 px-1.5 py-0.5 text-[11px] text-saffron">
                    {e.type}
                  </span>
                  <span className="text-fg-muted">{shortId(e.sessionId)}</span>
                  <span className="ml-auto flex-none text-fg-muted">{ago(e.ts, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
