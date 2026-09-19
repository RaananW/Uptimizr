/**
 * Session narrative — the `query:raw`-gated compaction of one session's raw
 * event stream into an ordered, bounded account of what it did
 * (ADR 0051 §7, design sketch §G.2).
 *
 * Pure functions over `AnyEvent[]`: no store, no request, no I/O. The collector
 * serves them on `GET /api/v1/sessions/:id/narrative`; the shapes and bounds
 * live in `@uptimizr/metrics` so the registry entry, the generated tool and this
 * implementation cannot drift.
 */

export { buildSessionNarrative } from "./build.js";
export type { SessionNarrative, SessionNarrativeOptions } from "./build.js";
export { renderSessionNarrativeText } from "./text.js";
