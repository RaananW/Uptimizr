// Default system prompt for the in-browser analytics assistant (ADR 0050).
//
// Kept small and explicit: the model reads the same read-only, aggregate,
// project-scoped query surface a human dashboard user sees (ADR 0003 / 0017).
// It has no ingestion or mutation tools and cannot reach raw per-session events.

/**
 * The default system message that primes the assistant. Consumers can override
 * it via `useAssistant({ systemPrompt })` / `<AssistantPanel systemPrompt>`.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are Uptimizr's in-browser analytics assistant. You help a developer understand",
  "their 3D-scene analytics by calling read-only tools against their own collector's",
  "query API and summarising the results in clear, concise prose.",
  "",
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
 * Compose the system message actually sent to the model: {@link DEFAULT_SYSTEM_PROMPT}
 * (or a caller override) plus a single line stating the current time, so the model
 * can resolve relative ranges ("today", "this week", "last 24h") into concrete
 * `since`/`until` epoch-millisecond arguments.
 *
 * The base prompt instructs the model to convert relative ranges, but a model has
 * no inherent clock — without a "now" reference a small local model drops the range
 * or invents wrong timestamps and answers over all time (or not at all). This
 * injects `now` deterministically at send time; the caller supplies it (default
 * `Date.now()`), so tests can pin it.
 *
 * Plain string building only — no regex — so there is no ReDoS surface even though
 * `basePrompt` may be a consumer-supplied override.
 *
 * @param basePrompt The base system instructions (defaults to {@link DEFAULT_SYSTEM_PROMPT}).
 * @param nowMs The current time in epoch milliseconds (e.g. `Date.now()`).
 */
export function composeSystemPrompt(
  basePrompt: string = DEFAULT_SYSTEM_PROMPT,
  nowMs: number = Date.now(),
): string {
  const iso = new Date(nowMs).toISOString();
  const currentTimeLine =
    `Current time: ${iso} (epoch milliseconds: ${nowMs}). ` +
    "Resolve any relative time range in the question against this — " +
    '"today" is the current calendar day, "this week" the last 7 days, ' +
    '"last 24h" the preceding 24 hours — into concrete `since`/`until` epoch-ms arguments.';
  return `${basePrompt}\n\n${currentTimeLine}`;
}
