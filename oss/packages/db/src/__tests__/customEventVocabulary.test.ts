/**
 * The pure half of the custom-event vocabulary (ADR 0051 §5, design sketch §E.1).
 *
 * `buildCustomEventVocabulary` is covered by the DuckDB parity suite (counting
 * and sampling shape); this suite covers `foldCustomEventVocabulary` — the
 * prop-key discovery that deliberately does **not** live in SQL, because key
 * enumeration over an open JSON object has no portable spelling across the four
 * supported engines.
 */

import { describe, expect, it } from "vitest";
import {
  CUSTOM_EVENT_VOCABULARY_MAX_PROPS,
  foldCustomEventVocabulary,
} from "../query/customEventVocabulary.js";
import type { CustomEventVocabularySampleRow } from "../query/types.js";

/** One sampled row as the aggregation emits it (totals repeated per sample). */
function sample(
  name: string,
  count: number,
  sessions: number,
  payload: unknown,
): CustomEventVocabularySampleRow {
  return { name, count, sessions, sample_payload: payload };
}

/** The event `payload` document as the store holds it, JSON-encoded. */
function payload(name: string, props: Record<string, unknown>): string {
  return JSON.stringify({ type: "custom", name, props });
}

describe("foldCustomEventVocabulary", () => {
  it("collapses the repeated totals into one row per name", () => {
    const rows = foldCustomEventVocabulary([
      sample("add_to_cart", 3, 2, payload("add_to_cart", { sku: "a" })),
      sample("add_to_cart", 3, 2, payload("add_to_cart", { sku: "b" })),
      sample("add_to_cart", 3, 2, payload("add_to_cart", { sku: "c" })),
      sample("level_complete", 1, 1, payload("level_complete", { level: 3 })),
    ]);

    expect(rows).toEqual([
      { name: "add_to_cart", count: 3, sessions: 2, props: { sku: "string" } },
      { name: "level_complete", count: 1, sessions: 1, props: { level: "number" } },
    ]);
  });

  it("unions prop keys across the sample and types each one", () => {
    const [row] = foldCustomEventVocabulary([
      sample("checkout", 2, 1, payload("checkout", { sku: "a", qty: 2 })),
      sample("checkout", 2, 1, payload("checkout", { sku: "b", gift: true })),
    ]);

    expect(row!.props).toEqual({ sku: "string", qty: "number", gift: "boolean" });
  });

  it("reports a key seen with two kinds as `mixed`", () => {
    const [row] = foldCustomEventVocabulary([
      sample("checkout", 2, 1, payload("checkout", { qty: 2 })),
      sample("checkout", 2, 1, payload("checkout", { qty: "two" })),
    ]);

    expect(row!.props).toEqual({ qty: "mixed" });
  });

  it("treats an explicit null as an optional value, not a type conflict", () => {
    const both = foldCustomEventVocabulary([
      sample("checkout", 2, 1, payload("checkout", { sku: "a" })),
      sample("checkout", 2, 1, payload("checkout", { sku: null })),
    ]);
    // …in either order: a null seen first is replaced by the concrete kind.
    const reversed = foldCustomEventVocabulary([
      sample("checkout", 2, 1, payload("checkout", { sku: null })),
      sample("checkout", 2, 1, payload("checkout", { sku: "a" })),
    ]);

    expect(both[0]!.props).toEqual({ sku: "string" });
    expect(reversed[0]!.props).toEqual({ sku: "string" });
  });

  it("reports `null` only when every sampled value was null", () => {
    const [row] = foldCustomEventVocabulary([
      sample("ping", 2, 1, payload("ping", { ref: null })),
      sample("ping", 2, 1, payload("ping", { ref: null })),
    ]);

    expect(row!.props).toEqual({ ref: "null" });
  });

  it("accepts an already-parsed payload object (the Postgres `jsonb` driver)", () => {
    const [row] = foldCustomEventVocabulary([
      sample("checkout", 1, 1, { type: "custom", name: "checkout", props: { sku: "a" } }),
    ]);

    expect(row!.props).toEqual({ sku: "string" });
  });

  it("keeps the name but no props when the payload is absent, malformed or props-less", () => {
    const rows = foldCustomEventVocabulary([
      sample("a", 1, 1, null),
      sample("b", 1, 1, "{not json"),
      sample("c", 1, 1, payload("c", {})),
      sample("d", 1, 1, JSON.stringify({ type: "custom", name: "d" })),
      sample("e", 1, 1, JSON.stringify({ type: "custom", name: "e", props: ["not", "a", "map"] })),
    ]);

    expect(rows.map((row) => row.name)).toEqual(["a", "b", "c", "d", "e"]);
    for (const row of rows) expect(row.props).toEqual({});
  });

  it("ignores prop values the event schema cannot produce", () => {
    const [row] = foldCustomEventVocabulary([
      sample("weird", 1, 1, JSON.stringify({ props: { ok: 1, nested: { a: 1 }, list: [1, 2] } })),
    ]);

    expect(row!.props).toEqual({ ok: "number" });
  });

  it("bounds the number of prop keys per name", () => {
    const wide = Object.fromEntries(
      Array.from({ length: CUSTOM_EVENT_VOCABULARY_MAX_PROPS + 10 }, (_, i) => [`k${i}`, i]),
    );
    const [defaulted] = foldCustomEventVocabulary([sample("wide", 1, 1, payload("wide", wide))]);
    const [capped] = foldCustomEventVocabulary([sample("wide", 1, 1, payload("wide", wide))], {
      maxProps: 3,
    });

    expect(Object.keys(defaulted!.props)).toHaveLength(CUSTOM_EVENT_VOCABULARY_MAX_PROPS);
    expect(Object.keys(capped!.props)).toEqual(["k0", "k1", "k2"]);
  });

  it("returns no rows for no samples", () => {
    expect(foldCustomEventVocabulary([])).toEqual([]);
  });
});
