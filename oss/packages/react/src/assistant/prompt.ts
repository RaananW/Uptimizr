// Default system prompt for the in-browser analytics assistant (ADR 0050).
//
// Kept small and explicit: the model reads the same read-only, aggregate,
// project-scoped query surface a human dashboard user sees (ADR 0003 / 0017).
// It has no ingestion or mutation tools and cannot reach raw per-session events.

import type { AgentMessage } from "@uptimizr/agent-core";

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

/**
 * Return a transcript that carries exactly **one** `system` message — at index 0
 * — whose content is {@link composeSystemPrompt}(`basePrompt`, `nowMs`), i.e. a
 * freshly stamped current time. Called on **every** send (not just the first) so
 * a long-lived conversation that crosses a calendar boundary keeps resolving
 * "today" / "this week" against the real current time instead of the time of
 * the first turn (issue #220).
 *
 * - An empty transcript gets a new system message.
 * - An existing system message is **replaced in place** (its content updated),
 *   never duplicated — so the model sees one system turn, and providers that fold
 *   the system prompt (WebLLM's Hermes path) fold exactly one.
 * - Any stray extra `system` turns are dropped, so the invariant holds even for a
 *   caller-seeded history. All other turns keep their relative order.
 *
 * Pure: the input array is never mutated. Plain array/string operations only —
 * no regex over prompt text.
 *
 * @param messages The current transcript (may be empty).
 * @param basePrompt The base system instructions (defaults to {@link DEFAULT_SYSTEM_PROMPT}).
 * @param nowMs The current time in epoch milliseconds (e.g. `Date.now()`).
 */
export function refreshSystemPrompt(
  messages: readonly AgentMessage[],
  basePrompt: string = DEFAULT_SYSTEM_PROMPT,
  nowMs: number = Date.now(),
): AgentMessage[] {
  const system: AgentMessage = { role: "system", content: composeSystemPrompt(basePrompt, nowMs) };
  const rest = messages.filter((message) => message.role !== "system");
  return [system, ...rest];
}
