// Default system prompt for the in-browser analytics assistant (ADR 0050).
//
// Kept small and explicit: the model reads the same read-only, aggregate,
// project-scoped query surface a human dashboard user sees (ADR 0003 / 0017).
// It has no ingestion or mutation tools and cannot reach raw per-session events.

import {
  ANALYTICS_AGENT_GUIDELINES,
  renderCurrentTimeLine,
  type AgentMessage,
} from "@uptimizr/agent-core";

/**
 * The default system message that primes the assistant. Consumers can override
 * it via `useAssistant({ systemPrompt })` / `<AssistantPanel systemPrompt>`.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are Uptimizr's in-browser analytics assistant. You help a developer understand",
  "their 3D-scene analytics by calling read-only tools against their own collector's",
  "query API and summarising the results in clear, concise prose.",
  "",
  // The behavioural half is shared with the headless `uptimizr agent report` CLI
  // (ADR 0051 §6) so what the two clients promise about the data cannot drift.
  ANALYTICS_AGENT_GUIDELINES,
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
 * The optional third part is the **project context block** (ADR 0051 §5): the
 * compact rendering of the collector's `GET /api/v1/context` document produced by
 * `renderContextForPrompt` in `@uptimizr/agent-core` — the project's real scene
 * ids, region ids and custom-event names, and which metrics cannot have data.
 * It is appended last, closest to the question, and omitted entirely when empty
 * (an older collector without the endpoint, or a project with nothing to say),
 * so the prompt is byte-identical to before in that case.
 *
 * @param basePrompt The base system instructions (defaults to {@link DEFAULT_SYSTEM_PROMPT}).
 * @param nowMs The current time in epoch milliseconds (e.g. `Date.now()`).
 * @param projectContext Pre-rendered project context block, or `""` for none.
 */
export function composeSystemPrompt(
  basePrompt: string = DEFAULT_SYSTEM_PROMPT,
  nowMs: number = Date.now(),
  projectContext = "",
): string {
  const currentTimeLine = renderCurrentTimeLine(nowMs);
  const context = projectContext.trim();
  return context.length > 0
    ? `${basePrompt}\n\n${currentTimeLine}\n\n${context}`
    : `${basePrompt}\n\n${currentTimeLine}`;
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
 * @param projectContext Pre-rendered project context block, or `""` for none.
 *   Re-stamped on every send too, so a context that arrives after the first turn
 *   still reaches the model.
 */
export function refreshSystemPrompt(
  messages: readonly AgentMessage[],
  basePrompt: string = DEFAULT_SYSTEM_PROMPT,
  nowMs: number = Date.now(),
  projectContext = "",
): AgentMessage[] {
  const system: AgentMessage = {
    role: "system",
    content: composeSystemPrompt(basePrompt, nowMs, projectContext),
  };
  const rest = messages.filter((message) => message.role !== "system");
  return [system, ...rest];
}
