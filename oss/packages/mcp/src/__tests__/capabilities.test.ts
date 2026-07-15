import { describe, expect, it } from "vitest";
import { readTools } from "@uptimizr/agent-core";
import { buildCapabilities } from "../capabilities.js";

describe("buildCapabilities", () => {
  const cap = buildCapabilities();

  it("declares the surface read-only", () => {
    expect(cap.readOnly).toBe(true);
    expect(cap.schemaVersion).toMatch(/^\d+\.\d+$/);
  });

  it("lists canonical event types", () => {
    expect(cap.eventTypes.length).toBeGreaterThan(0);
    expect(cap.eventTypes).toContain("pointer_click");
    expect(cap.eventTypes).toContain("session_start");
  });

  it("represents every catalog tool exactly once", () => {
    expect(cap.tools).toHaveLength(readTools.length);
    const names = cap.tools.map((t) => t.name).sort();
    const expected = readTools.map((t) => t.name).sort();
    expect(names).toEqual(expected);
  });

  it("includes the new #194 read tools", () => {
    const names = cap.tools.map((t) => t.name);
    for (const n of [
      "funnel",
      "aggregate_paths",
      "rendering_technology",
      "xr_rotation",
      "xr_sources",
      "xr_abandonment",
      "xr_locomotion",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("documents every parameter a tool uses", () => {
    const glossary = new Map(cap.params.map((p) => [p.name, p.description]));
    for (const tool of cap.tools) {
      for (const param of tool.params) {
        expect(glossary.has(param)).toBe(true);
        expect(glossary.get(param)).toBeTruthy();
      }
    }
  });

  it("exposes no ingestion or mutation tools", () => {
    for (const tool of cap.tools) {
      expect(tool.name).not.toMatch(/collect|ingest|delete|update|create|put|post/i);
    }
  });
});
