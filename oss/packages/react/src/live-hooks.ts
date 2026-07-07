"use client";

// Browser-side live-follow hooks for a single session (ADR 0032 §3, §4).
//
// These live in `@uptimizr/react` (not the dashboard app) so the portable
// Session Replay panel can tail a live session's event stream on its own — the
// panel contract's `ctx.live` exposes the aggregate firehose + presence roster,
// but a per-session live tail (with connect-time backfill and retention gating)
// is session-scoped and self-managed by the panel that needs it.
//
// The connection itself is owned by `CollectorApi.liveSession` (the transport
// seam): a host CollectorApi supplies its own auth (cookies, `withCredentials`,
// …) there instead of the panel baking a URL + token. These hooks are thin
// React wrappers that turn that subscription into reactive `LiveSessionState`.

import { useEffect, useMemo, useRef, useState } from "react";
import { CollectorApi } from "./api";
import type { LiveEvent, LiveSessionState } from "./live";

export type { LiveSessionState, LiveStatus } from "./live";

const IDLE_STATE: LiveSessionState = { status: "idle", gated: false, count: 0 };

/**
 * Follow a single session's live event tail through a {@link CollectorApi} — the
 * transport seam (ADR 0032 §3, §4). `onReset` fires before each (re)connection
 * so the consumer can clear state before the connect-time backfill is replayed.
 * Returns the connection lifecycle plus a `gated` flag (retention disabled) and
 * the applied-event `count`.
 *
 * This is the api-keyed hook the portable Session Replay panel uses: the panel
 * receives a `CollectorApi` (never `baseUrl`/`apiKey`), so a host backing
 * `ctx.api` gets live-follow for free.
 */
export function useSessionTail(
  api: CollectorApi,
  sessionId: string,
  enabled: boolean,
  onEvent: (event: LiveEvent) => void,
  onReset: () => void,
): LiveSessionState {
  const [state, setState] = useState<LiveSessionState>(IDLE_STATE);
  const onEventRef = useRef(onEvent);
  const onResetRef = useRef(onReset);
  onEventRef.current = onEvent;
  onResetRef.current = onReset;

  useEffect(() => {
    if (!enabled) {
      setState(IDLE_STATE);
      return;
    }
    return api.liveSession(sessionId, (event) => onEventRef.current(event), {
      onReset: () => onResetRef.current(),
      onState: setState,
    });
  }, [api, sessionId, enabled]);

  return state;
}

/**
 * Backward-compatible wrapper keyed on `(baseUrl, apiKey)` (ADR 0049): builds a
 * {@link CollectorApi} for the pair and delegates to {@link useSessionTail}, so
 * existing collector-coupled callers keep working while the connection still
 * flows through the transport seam.
 */
export function useLiveSession(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  enabled: boolean,
  onEvent: (event: LiveEvent) => void,
  onReset: () => void,
): LiveSessionState {
  const api = useMemo(() => new CollectorApi(baseUrl, apiKey), [baseUrl, apiKey]);
  return useSessionTail(api, sessionId, enabled, onEvent, onReset);
}
