/**
 * `renderSessionNarrativeText` — the `format=text` rendering of a session
 * narrative (ADR 0051 §7).
 *
 * Why a third format at all, when `full` and `table` already exist: the
 * narrative's one consumer is a language model reading a session back, and a
 * JSON array of two hundred objects spends most of its tokens on repeated key
 * names. A line-per-entry rendering of the same data is roughly a third of the
 * tokens and is what a model reads best. It is **only** offered on this route;
 * no other endpoint gains a text format (design sketch §B.1 keeps `full`,
 * `table` and `summary` as the shared envelopes).
 *
 * The output is derived entirely from the narrative's own fields — this module
 * adds no information and reads no event — so the privacy allow-list enforced by
 * `buildSessionNarrative` holds for it unchanged.
 */

import type { SessionNarrative } from "./build.js";

/** `1200` → `"1.2s"`, padded so the timestamps form a readable column. */
function stamp(tMs: number): string {
  const seconds = (tMs / 1000).toFixed(1);
  return `${seconds}s`.padStart(8);
}

/**
 * Render a narrative as plain text: a header line naming the session and its
 * span, then one line per entry (`<t>  <kind>  <summary>`), oldest first, ending
 * with the totals line. Never longer than the narrative's own entry count plus
 * one, so `maxEntries` bounds the text exactly as it bounds the JSON.
 */
export function renderSessionNarrativeText(narrative: SessionNarrative): string {
  const { totals } = narrative;
  const lines = [
    `session ${narrative.sessionId} — ${totals.events} events over ` +
      `${(totals.durationMs / 1000).toFixed(1)}s` +
      (narrative.truncated ? " (truncated)" : ""),
  ];
  const width = narrative.entries.reduce((max, entry) => Math.max(max, entry.kind.length), 0);
  for (const entry of narrative.entries) {
    lines.push(`${stamp(entry.tMs)}  ${entry.kind.padEnd(width)}  ${entry.summary}`);
  }
  return `${lines.join("\n")}\n`;
}
