import { describe, expect, it } from "vitest";
import { readTools } from "@uptimizr/agent-core";
import { allMetrics, isResourceMetric } from "@uptimizr/db/registry";
import { buildCapabilities } from "../capabilities.js";

describe("buildCapabilities", () => {
  const cap = buildCapabilities();
  const metrics = allMetrics();
  const served = metrics.filter((metric) => metric.endpoint != null);

  it("declares the surface read-only", () => {
    expect(cap.readOnly).toBe(true);
    expect(cap.schemaVersion).toMatch(/^\d+\.\d+$/);
  });

  it("lists canonical event types", () => {
    expect(cap.eventTypes.length).toBeGreaterThan(0);
    expect(cap.eventTypes).toContain("pointer_click");
    expect(cap.eventTypes).toContain("session_start");
  });

  it("represents every served registry metric exactly once", () => {
    expect(cap.tools).toHaveLength(served.length);
    const names = cap.tools.map((t) => t.name).sort();
    expect(names).toEqual(served.map((metric) => metric.id).sort());
  });

  it("is a superset of the shipped hand-written tool catalog (sketch §A.4)", () => {
    // The generated catalog must never drop a tool name an MCP client already
    // calls; the registry reuses those 20 ids verbatim.
    const names = new Set(cap.tools.map((t) => t.name));
    for (const tool of readTools) expect(names.has(tool.name), tool.name).toBe(true);
  });

  it("includes the #194 read tools", () => {
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
      // Word-bounded: `top_input_actions` legitimately contains "put".
      expect(tool.name).not.toMatch(/\b(collect|ingest|delete|update|create|post)\b/i);
    }
    // The stronger guarantee: every served metric is a GET read.
    for (const metric of served) expect(metric.endpoint!.method, metric.id).toBe("GET");
  });

  it("serialises the whole registry, including the builder-less resources", () => {
    expect(cap.metrics).toHaveLength(metrics.length);
    expect(cap.metrics.map((m) => m.id).sort()).toEqual(metrics.map((m) => m.id).sort());
    expect(
      cap.metrics
        .filter((m) => m.resource)
        .map((m) => m.id)
        .sort(),
    ).toEqual(
      metrics
        .filter(isResourceMetric)
        .map((m) => m.id)
        .sort(),
    );
  });

  it("never leaks the SQL builder name", () => {
    for (const descriptor of cap.metrics) {
      expect(Object.keys(descriptor), descriptor.id).not.toContain("builder");
    }
  });

  it("exposes units, grain, dimensions and caveats per metric", () => {
    for (const metric of metrics) {
      const descriptor = cap.metrics.find((m) => m.id === metric.id)!;
      expect(descriptor.grain, metric.id).toBe(metric.grain);
      expect(descriptor.dimensions, metric.id).toEqual(metric.dimensions);
      expect(descriptor.caveats, metric.id).toEqual(metric.caveats);
      expect(descriptor.interpretation, metric.id).toBe(metric.interpretation);
      expect(descriptor.sourceChannels, metric.id).toEqual(metric.sourceChannels);
      expect(descriptor.limits, metric.id).toEqual(metric.limits);
      expect(descriptor.category, metric.id).toBe(metric.category);
      expect(Object.keys(descriptor.columns), metric.id).toEqual(Object.keys(metric.columns));
      for (const [name, column] of Object.entries(metric.columns)) {
        expect(descriptor.columns[name], `${metric.id}.${name}`).toEqual(column);
      }
    }
  });

  it("replaces the Zod row schema with a plain JSON Schema", () => {
    for (const descriptor of cap.metrics) {
      expect(descriptor.row.type, descriptor.id).toBe("object");
      const properties = descriptor.row.properties as Record<string, unknown>;
      expect(Object.keys(properties), descriptor.id).toEqual(Object.keys(descriptor.columns));
      // No Zod internals and no JSON-Schema dialect marker survive serialisation.
      expect(descriptor.row.$schema, descriptor.id).toBeUndefined();
    }
    expect(JSON.parse(JSON.stringify(cap.metrics))).toEqual(cap.metrics);
  });

  it("is JSON-serialisable, which is how the resource is served", () => {
    expect(() => JSON.stringify(cap)).not.toThrow();
  });
});
