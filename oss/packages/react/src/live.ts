// Shared live-layer types (ADR 0032 / ADR 0036). The browser-side SSE hooks
// live in the dashboard app, but the event shape is shared so the panel
// contract (and any embedding app) can type a live subscription.

/** Minimal shape of a live event as delivered over the firehose. */
export interface LiveEvent {
  type: string;
  sessionId: string;
  ts: number;
  sceneId?: string;
  [key: string]: unknown;
}

/** Connection lifecycle state surfaced to the UI by the live SSE hooks. */
export type LiveStatus = "idle" | "connecting" | "open" | "reconnecting";

/**
 * Status of a per-session live-follow connection (ADR 0032 §3, ADR 0035).
 * `gated` means raw-session retention is off, so the collector refuses the tail.
 */
export interface LiveSessionState {
  status: LiveStatus;
  /** True when the collector rejected the tail because raw-session retention is off. */
  gated: boolean;
  /** Total events applied since the connection (or last reset) opened. */
  count: number;
}
