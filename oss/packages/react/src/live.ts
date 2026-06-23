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
