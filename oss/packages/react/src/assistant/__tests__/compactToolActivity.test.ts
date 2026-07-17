import { describe, expect, it } from "vitest";
import type { AssistantToolActivity } from "../useAssistant";
import { compactToolActivity } from "../AssistantPanel";

/**
 * `compactToolActivity` folds consecutive same-name, same-status tool entries
 * into one counted row so a small local model's long, near-duplicate list (e.g.
 * `top_meshes` ×12) stays readable — without reordering or dropping distinct runs.
 */
describe("compactToolActivity", () => {
  it("returns an empty list for no entries", () => {
    expect(compactToolActivity([])).toEqual([]);
  });

  it("folds a run of consecutive identical entries into one counted row", () => {
    const entries: AssistantToolActivity[] = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      name: "top_meshes",
      status: "done",
    }));
    expect(compactToolActivity(entries)).toEqual([
      { name: "top_meshes", status: "done", count: 12 },
    ]);
  });

  it("keeps a single call at count 1", () => {
    expect(compactToolActivity([{ name: "top_meshes", status: "done" }])).toEqual([
      { name: "top_meshes", status: "done", count: 1 },
    ]);
  });

  it("does not merge across a differing name or status", () => {
    const entries: AssistantToolActivity[] = [
      { name: "top_meshes", status: "done" },
      { name: "top_meshes", status: "done" },
      { name: "top_sessions", status: "done" },
      { name: "top_meshes", status: "error" },
      { name: "top_meshes", status: "done" },
    ];
    expect(compactToolActivity(entries)).toEqual([
      { name: "top_meshes", status: "done", count: 2 },
      { name: "top_sessions", status: "done", count: 1 },
      { name: "top_meshes", status: "error", count: 1 },
      { name: "top_meshes", status: "done", count: 1 },
    ]);
  });

  it("only folds ADJACENT duplicates (order is preserved)", () => {
    const entries: AssistantToolActivity[] = [
      { name: "a", status: "running" },
      { name: "a", status: "running" },
      { name: "b", status: "running" },
      { name: "a", status: "running" },
    ];
    expect(compactToolActivity(entries)).toEqual([
      { name: "a", status: "running", count: 2 },
      { name: "b", status: "running", count: 1 },
      { name: "a", status: "running", count: 1 },
    ]);
  });
});
