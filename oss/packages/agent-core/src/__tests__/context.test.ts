/**
 * The system-prompt rendering of the project context document (ADR 0051 §5).
 *
 * Two things matter here and nothing else: the block puts the **real names** an
 * agent needs in front of the model, and it stays small enough that a 1–3 B
 * local model can carry it alongside the tool schemas. Everything else is the
 * tolerance the rendering needs to survive a collector older or newer than the
 * client.
 */

import { describe, expect, it } from "vitest";
import {
  CONTEXT_PROMPT_MAX_CHARS,
  renderContextForPrompt,
  type PromptContextDocument,
} from "../context.js";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const CONTEXT: PromptContextDocument = {
  project: { id: "p1", store: "duckdb", collectorVersion: "2.0.0" },
  dataQuality: {
    lastEventAt: NOW - 30 * 60_000,
    sessions24h: 91,
    events24h: 18_023,
    retention: { rawSessions: false },
  },
  scenes: [
    {
      id: "lobby",
      label: "Main Lobby",
      proxy: true,
      regions: [
        { id: "counter", label: "Checkout counter" },
        { id: "door", label: "Front door" },
      ],
    },
    { id: "arena", label: null, proxy: false, regions: [] },
  ],
  vocabulary: {
    customEvents: [
      { name: "add_to_cart", count28d: 311, props: { sku: "string", qty: "number" } },
      { name: "level_complete", count28d: 12, props: {} },
    ],
    meshes: { count: 63, top: ["checkout_button", "door_left"] },
    inputActions: ["jump", "sprint"],
  },
  definitions: { glossary: [{ term: "btn_01", meaning: "the buy button" }] },
  annotations: { recent: [{ text: "Launch of v2 lobby", at: NOW - 86_400_000 }] },
  metrics: { disabledByCapture: ["mesh_dwell", "top_input_actions"] },
};

describe("renderContextForPrompt", () => {
  const rendered = renderContextForPrompt(CONTEXT, NOW);

  it("lists the scene ids and their region ids", () => {
    expect(rendered).toContain("lobby");
    expect(rendered).toContain('"Main Lobby"');
    expect(rendered).toContain("regions: counter, door");
    expect(rendered).toContain("arena");
  });

  it("lists custom event names with their prop keys and types", () => {
    expect(rendered).toContain("add_to_cart");
    expect(rendered).toContain("sku: string");
    expect(rendered).toContain("qty: number");
  });

  it("names the meshes, input actions and glossary terms", () => {
    expect(rendered).toContain("checkout_button");
    expect(rendered).toContain("jump");
    expect(rendered).toContain("btn_01: the buy button");
  });

  it("warns about metrics that cannot have data", () => {
    expect(rendered).toContain("mesh_dwell");
    expect(rendered).toContain("WILL return empty");
  });

  it("states freshness and that raw retention is off", () => {
    expect(rendered).toContain("30 min ago");
    expect(rendered).toContain("91 sessions in the last 24 h");
    expect(rendered).toContain("Raw per-session retention is OFF");
  });

  it("stays small enough for a local model's prompt budget", () => {
    expect(rendered.length).toBeLessThan(1500);
    expect(rendered.length).toBeLessThanOrEqual(CONTEXT_PROMPT_MAX_CHARS);
  });

  it("truncates a pathological document on a line boundary", () => {
    // Every list is capped, so overflow can only come from oversized *values* —
    // a scene label or a glossary entry the collector let through.
    const huge: PromptContextDocument = {
      scenes: Array.from({ length: 20 }, (_, i) => ({
        id: `scene-${i}`,
        label: "x".repeat(600),
      })),
    };
    const out = renderContextForPrompt(huge, NOW);
    expect(out.length).toBeLessThanOrEqual(CONTEXT_PROMPT_MAX_CHARS + 32);
    expect(out).toContain("(context truncated)");
  });

  it("caps long lists rather than dropping them silently", () => {
    const many: PromptContextDocument = {
      vocabulary: {
        customEvents: Array.from({ length: 40 }, (_, i) => ({ name: `e${i}`, count28d: 1 })),
      },
    };
    expect(renderContextForPrompt(many, NOW)).toContain("(+25 more)");
  });

  it("says nothing for an empty, missing or unusable document", () => {
    expect(renderContextForPrompt(null, NOW)).toBe("");
    expect(renderContextForPrompt(undefined, NOW)).toBe("");
    expect(renderContextForPrompt({}, NOW)).toBe("");
    expect(renderContextForPrompt({ scenes: [], vocabulary: null }, NOW)).toBe("");
  });

  it("renders what it recognises from a partial (older or newer) document", () => {
    const partial = { scenes: [{ id: "lobby" }], somethingNew: 42 } as PromptContextDocument;
    const out = renderContextForPrompt(partial, NOW);
    expect(out).toContain("lobby");
    expect(out).not.toContain("undefined");
  });

  it("reports a project with no events at all", () => {
    const empty: PromptContextDocument = {
      dataQuality: { lastEventAt: null, sessions24h: 0, retention: { rawSessions: true } },
    };
    const out = renderContextForPrompt(empty, NOW);
    expect(out).toContain("no events recorded yet");
    expect(out).not.toContain("retention is OFF");
  });
});
