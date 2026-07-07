"use client";

// Browser-side live layer for the dashboard (ADR 0032 §3). Each hook mints a
// short-lived token from the project API key, opens an `EventSource` against a
// collector SSE endpoint, and manages reconnect + token refresh itself. We do
// the reconnect manually (rather than relying on EventSource's built-in retry)
// because a token can expire mid-stream: on any error we close, mint a fresh
// token, and reopen with a small backoff.

import { useEffect, useRef, useState } from "react";
import { CollectorApi, type PresenceSnapshot } from "@/lib/api";

// The per-session live-follow hook (`useLiveSession`) and its `LiveSessionState`
// now live in `@uptimizr/react` (ADR 0049) alongside the portable Session Replay
// panel. `LiveStatus` is likewise owned by the package; the aggregate presence /
// firehose hooks below stay here because they drive dashboard-shell chrome.
export type { LiveEvent, LiveStatus, LiveSessionState } from "@uptimizr/react";
import type { LiveEvent, LiveStatus } from "@uptimizr/react";
export { useLiveSession } from "@uptimizr/react";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

interface LiveController {
  cancelled: boolean;
  source: EventSource | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Open an SSE connection with token minting + auto-reconnect. `bind` wires the
 * named-event listeners on the freshly opened `EventSource`. Returns a teardown.
 */
function openManaged(
  api: CollectorApi,
  buildUrl: (token: string) => string,
  bind: (source: EventSource) => void,
  setStatus: (s: LiveStatus) => void,
): () => void {
  const ctrl: LiveController = { cancelled: false, source: null, timer: null };
  let attempt = 0;

  const connect = async (): Promise<void> => {
    if (ctrl.cancelled) return;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    let url: string;
    try {
      const { token } = await api.liveToken();
      url = buildUrl(token);
    } catch {
      scheduleReconnect();
      return;
    }
    if (ctrl.cancelled) return;

    const source = new EventSource(url);
    ctrl.source = source;
    source.onopen = () => {
      attempt = 0;
      setStatus("open");
    };
    // EventSource surfaces auth/expiry/network failures as a generic error; we
    // tear down and reconnect with a fresh token rather than let it loop on the
    // stale URL.
    source.onerror = () => {
      source.close();
      if (ctrl.source === source) ctrl.source = null;
      scheduleReconnect();
    };
    bind(source);
  };

  const scheduleReconnect = (): void => {
    if (ctrl.cancelled) return;
    setStatus("reconnecting");
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    ctrl.timer = setTimeout(() => void connect(), delay);
  };

  void connect();

  return () => {
    ctrl.cancelled = true;
    if (ctrl.timer) clearTimeout(ctrl.timer);
    ctrl.source?.close();
    ctrl.source = null;
  };
}

/**
 * Subscribe to the aggregate presence roster (ADR 0032 §3). Returns the latest
 * snapshot and the connection status. Disabled until `enabled` and a key are set.
 */
export function useLivePresence(
  baseUrl: string,
  apiKey: string,
  enabled: boolean,
): { snapshot: PresenceSnapshot | null; status: LiveStatus } {
  const [snapshot, setSnapshot] = useState<PresenceSnapshot | null>(null);
  const [status, setStatus] = useState<LiveStatus>("idle");

  useEffect(() => {
    if (!enabled || !apiKey || !baseUrl) {
      setStatus("idle");
      setSnapshot(null);
      return;
    }
    const api = new CollectorApi(baseUrl, apiKey);
    const teardown = openManaged(
      api,
      (token) => api.livePresenceUrl(token),
      (source) => {
        source.addEventListener("presence", (ev) => {
          try {
            setSnapshot(JSON.parse((ev as MessageEvent).data) as PresenceSnapshot);
          } catch {
            /* ignore malformed frame */
          }
        });
      },
      setStatus,
    );
    return teardown;
  }, [baseUrl, apiKey, enabled]);

  return { snapshot, status };
}

/**
 * Subscribe to the project event firehose (ADR 0032 §3). Invokes `onEvent` for
 * each arriving event; `types` optionally restricts the server-side stream.
 * `onEvent` is held in a ref so changing it doesn't reopen the connection.
 */
export function useLiveStream(
  baseUrl: string,
  apiKey: string,
  enabled: boolean,
  onEvent: (event: LiveEvent) => void,
  types?: readonly string[],
): { status: LiveStatus } {
  const [status, setStatus] = useState<LiveStatus>("idle");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const typesKey = types && types.length > 0 ? [...types].sort().join(",") : "";

  useEffect(() => {
    if (!enabled || !apiKey || !baseUrl) {
      setStatus("idle");
      return;
    }
    const api = new CollectorApi(baseUrl, apiKey);
    const typeList = typesKey ? typesKey.split(",") : undefined;
    const teardown = openManaged(
      api,
      (token) => api.liveStreamUrl(token, typeList),
      (source) => {
        source.addEventListener("event", (ev) => {
          try {
            onEventRef.current(JSON.parse((ev as MessageEvent).data) as LiveEvent);
          } catch {
            /* ignore malformed frame */
          }
        });
      },
      setStatus,
    );
    return teardown;
  }, [baseUrl, apiKey, enabled, typesKey]);

  return { status };
}
