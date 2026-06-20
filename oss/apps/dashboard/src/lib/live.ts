"use client";

// Browser-side live layer for the dashboard (ADR 0032 §3). Each hook mints a
// short-lived token from the project API key, opens an `EventSource` against a
// collector SSE endpoint, and manages reconnect + token refresh itself. We do
// the reconnect manually (rather than relying on EventSource's built-in retry)
// because a token can expire mid-stream: on any error we close, mint a fresh
// token, and reopen with a small backoff.

import { useEffect, useRef, useState } from "react";
import { CollectorApi, type PresenceSnapshot } from "@/lib/api";

/** Minimal shape of a live event as delivered over the firehose. */
export interface LiveEvent {
  type: string;
  sessionId: string;
  ts: number;
  sceneId?: string;
  [key: string]: unknown;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/** Connection lifecycle state surfaced to the UI. */
export type LiveStatus = "idle" | "connecting" | "open" | "reconnecting";

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

/** Status of a per-session live-follow connection. `gated` means retention is off. */
export interface LiveSessionState {
  status: LiveStatus;
  /** True when the collector rejected the tail because raw-session retention is off. */
  gated: boolean;
  /** Total events applied since the connection (or last reset) opened. */
  count: number;
}

/**
 * Parse a chunked SSE response body, invoking `onEvent` for each `event: event`
 * frame's `data` payload. Resolves when the stream ends; rejects on read error.
 */
async function pumpSseBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  signal.addEventListener("abort", () => void reader.cancel().catch(() => {}));

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue; // comment / heartbeat
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (event === "event" && dataLines.length > 0) onEvent(dataLines.join("\n"));
      sep = buffer.indexOf("\n\n");
    }
  }
}

/**
 * Follow a single session's live event tail (ADR 0032 §3, §4). Unlike the other
 * hooks this reads the SSE over `fetch` rather than `EventSource` so it can see
 * the HTTP status: a `403` means raw-session retention is off, surfaced as
 * `gated` instead of an endless reconnect loop. `onReset` fires before each
 * (re)connection so the consumer can clear state before the connect-time
 * backfill is replayed.
 */
export function useLiveSession(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  enabled: boolean,
  onEvent: (event: LiveEvent) => void,
  onReset: () => void,
): LiveSessionState {
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [gated, setGated] = useState(false);
  const [count, setCount] = useState(0);
  const onEventRef = useRef(onEvent);
  const onResetRef = useRef(onReset);
  onEventRef.current = onEvent;
  onResetRef.current = onReset;

  useEffect(() => {
    if (!enabled || !apiKey || !baseUrl || !sessionId) {
      setStatus("idle");
      return;
    }
    const api = new CollectorApi(baseUrl, apiKey);
    let cancelled = false;
    let attempt = 0;
    let abort: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setGated(false);
    setCount(0);

    const scheduleReconnect = (): void => {
      if (cancelled) return;
      setStatus("reconnecting");
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt += 1;
      timer = setTimeout(() => void connect(), delay);
    };

    const connect = async (): Promise<void> => {
      if (cancelled) return;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      onResetRef.current();
      setCount(0);
      let token: string;
      try {
        ({ token } = await api.liveToken());
      } catch {
        scheduleReconnect();
        return;
      }
      if (cancelled) return;
      abort = new AbortController();
      try {
        const res = await fetch(api.liveSessionUrl(token, sessionId), {
          headers: { accept: "text/event-stream" },
          cache: "no-store",
          signal: abort.signal,
        });
        if (res.status === 403) {
          setGated(true);
          setStatus("idle");
          return; // Retention disabled — do not retry.
        }
        if (!res.ok || !res.body) {
          scheduleReconnect();
          return;
        }
        attempt = 0;
        setStatus("open");
        await pumpSseBody(res.body, abort.signal, (data) => {
          try {
            onEventRef.current(JSON.parse(data) as LiveEvent);
            setCount((c) => c + 1);
          } catch {
            /* ignore malformed frame */
          }
        });
        if (!cancelled) scheduleReconnect(); // Stream ended; reopen.
      } catch {
        if (!cancelled) scheduleReconnect();
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      abort?.abort();
    };
  }, [baseUrl, apiKey, sessionId, enabled]);

  return { status, gated, count };
}
