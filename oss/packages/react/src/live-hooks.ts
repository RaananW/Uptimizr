"use client";

// Browser-side live-follow hook for a single session (ADR 0032 §3, §4).
//
// This lives in `@uptimizr/react` (not the dashboard app) so the portable
// Session Replay panel can tail a live session's event stream on its own — the
// panel contract's `ctx.live` exposes the aggregate firehose + presence roster,
// but a per-session live tail (with connect-time backfill and retention gating)
// is session-scoped and self-managed by the panel that needs it.
//
// Unlike an `EventSource`, this reads the SSE over `fetch` so it can see the
// HTTP status: a `403` means raw-session retention is off, surfaced as `gated`
// instead of an endless reconnect loop.

import { useEffect, useRef, useState } from "react";
import { CollectorApi } from "./api";
import type { LiveEvent, LiveSessionState, LiveStatus } from "./live";

export type { LiveSessionState, LiveStatus } from "./live";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

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
 * Follow a single session's live event tail (ADR 0032 §3, §4). `onReset` fires
 * before each (re)connection so the consumer can clear state before the
 * connect-time backfill is replayed. Returns the connection lifecycle plus a
 * `gated` flag (retention disabled) and the applied-event `count`.
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
