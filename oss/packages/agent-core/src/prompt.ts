/**
 * The system-prompt fragments every Uptimizr analytics agent shares.
 *
 * Two clients now prime a model to read this collector's analytics: the
 * in-browser assistant (`@uptimizr/react`) and the headless
 * `uptimizr agent report` CLI (`@uptimizr/collector-server`, ADR 0051 §6). What
 * they say about the *data* must not diverge — that the figures come from tools
 * and are never invented, that everything is aggregate and privacy-preserving
 * (ADR 0003 / 0017), that timestamps are epoch milliseconds, that a tool error
 * is explained rather than papered over. Only the opening role sentence and the
 * output format legitimately differ between them, so only those live in the
 * clients.
 *
 * Pure strings and one pure function — no I/O, no regex over prompt text.
 */

/**
 * The shared behavioural guidelines, verbatim, as a `Guidelines:`-headed block.
 * A client prepends its own one-paragraph role statement and may append its own
 * output-format instructions.
 */
export const ANALYTICS_AGENT_GUIDELINES = [
  "Guidelines:",
  "- Use the provided tools to fetch data before answering; never invent numbers.",
  "- All data is aggregate and privacy-preserving — there are no raw per-session events,",
  "  no PII, and no way to ingest or modify data. Do not claim otherwise.",
  "- Timestamps are epoch milliseconds. When the user gives a relative range",
  '  ("this week", "last 24h"), convert it to `since`/`until` before calling a tool.',
  "- Prefer a short, direct answer with the key figures. Call out caveats (small sample",
  "  sizes, missing scenes) when relevant.",
  "- If a tool returns an error, explain what went wrong and, if useful, try a corrected call.",
].join("\n");

/**
 * The single line that gives the model a clock.
 *
 * The guidelines tell it to convert relative ranges, but a model has no inherent
 * clock — without a "now" reference it drops the range or invents timestamps and
 * answers over all time. Callers stamp it at send time so a long-lived session
 * keeps resolving "today" against the real current day.
 *
 * @param nowMs The current time in epoch milliseconds (e.g. `Date.now()`).
 */
export function renderCurrentTimeLine(nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  return (
    `Current time: ${iso} (epoch milliseconds: ${nowMs}). ` +
    "Resolve any relative time range in the question against this — " +
    '"today" is the current calendar day, "this week" the last 7 days, ' +
    '"last 24h" the preceding 24 hours — into concrete `since`/`until` epoch-ms arguments.'
  );
}
