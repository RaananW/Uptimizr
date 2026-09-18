/**
 * Folding the sampled `custom` payloads into a **vocabulary** (ADR 0051 §5,
 * design sketch §E.1).
 *
 * `buildCustomEventVocabulary` (in `aggregations.ts`) does the part SQL is good
 * at — counting events and sessions per developer-defined event name, and
 * picking that name's most recent payload documents. This module does the part
 * SQL cannot do portably: enumerate the keys of an open JSON object and give
 * each one a coarse type. It is a pure function over the rows the store already
 * has in hand, so it is unit-testable without a database and behaves identically
 * on every engine.
 *
 * Privacy (ADR 0003): only **key names and value kinds** are kept. No prop
 * *value* is ever read out of the sampled payload, so a custom event carrying a
 * user-supplied string cannot leak through the vocabulary.
 */

import type {
  CustomEventVocabularyRow,
  CustomEventVocabularySampleRow,
  CustomPropType,
} from "./types.js";

/**
 * Max prop keys reported per custom-event name. The SDK already bounds a custom
 * event's `props` count (`LIMITS.maxCustomPropEntries`), but a *union* across
 * sampled rows can still grow if a producer varies its keys — this keeps the
 * context document's size predictable regardless.
 */
export const CUSTOM_EVENT_VOCABULARY_MAX_PROPS = 40;

/** Options for {@link foldCustomEventVocabulary}. */
export interface FoldCustomEventVocabularyOptions {
  /** Max prop keys kept per name. Defaults to {@link CUSTOM_EVENT_VOCABULARY_MAX_PROPS}. */
  maxProps?: number;
}

/** The coarse JSON kind of one prop value. */
function propTypeOf(value: unknown): CustomPropType | null {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      // The event schema bounds `props` values to string | number | boolean |
      // null, so anything else is a payload that did not come through the SDK.
      // Ignore it rather than invent a type for it.
      return null;
  }
}

/**
 * The `props` object of one sampled payload, or `null` when the payload is
 * absent, unparseable, or carries no `props`.
 *
 * The payload arrives as text from DuckDB / ClickHouse / SQL Server and as an
 * already-parsed object from the Postgres driver (`jsonb`), so both are
 * accepted. A malformed document is skipped, never thrown on: one bad row must
 * not take down a project's whole context document.
 */
function propsOf(payload: unknown): Record<string, unknown> | null {
  let document: unknown = payload;
  if (typeof payload === "string") {
    if (payload.length === 0) return null;
    try {
      document = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (typeof document !== "object" || document === null) return null;
  const props = (document as { props?: unknown }).props;
  if (typeof props !== "object" || props === null || Array.isArray(props)) return null;
  return props as Record<string, unknown>;
}

/**
 * Fold the sampled rows of {@link buildCustomEventVocabulary} into one row per
 * custom-event name, with the union of observed prop keys and a coarse type per
 * key.
 *
 * - Rows keep the order the query produced (count descending, then name), and a
 *   name appears exactly once.
 * - A key seen with two different JSON kinds across the sample is reported as
 *   `"mixed"` — an honest signal that the producer is inconsistent, which is far
 *   more useful to an agent than silently picking the first kind seen.
 * - Keys are truncated to `maxProps`, in first-seen order, so the result stays
 *   bounded whatever the sample contains.
 *
 * Pure: the input is never mutated.
 */
export function foldCustomEventVocabulary(
  rows: readonly CustomEventVocabularySampleRow[],
  options: FoldCustomEventVocabularyOptions = {},
): CustomEventVocabularyRow[] {
  const maxProps = options.maxProps ?? CUSTOM_EVENT_VOCABULARY_MAX_PROPS;
  const byName = new Map<
    string,
    { row: CustomEventVocabularyRow; props: Map<string, CustomPropType> }
  >();

  for (const row of rows) {
    let entry = byName.get(row.name);
    if (!entry) {
      entry = {
        row: { name: row.name, count: row.count, sessions: row.sessions, props: {} },
        props: new Map(),
      };
      byName.set(row.name, entry);
    }
    const props = propsOf(row.sample_payload);
    if (!props) continue;
    for (const [key, value] of Object.entries(props)) {
      const type = propTypeOf(value);
      if (type == null) continue;
      const seen = entry.props.get(key);
      if (seen === undefined) {
        if (entry.props.size >= maxProps) continue;
        entry.props.set(key, type);
      } else if (seen === type || seen === "mixed" || type === "null") {
        // Same kind again, already mixed, or an explicit null for a key whose
        // concrete kind is known — an optional prop is not a type conflict.
      } else if (seen === "null") {
        entry.props.set(key, type);
      } else {
        entry.props.set(key, "mixed");
      }
    }
  }

  return [...byName.values()].map(({ row, props }) => ({
    ...row,
    props: Object.fromEntries(props),
  }));
}
