/**
 * The coverage rule from the design sketch: the bank must span every registry
 * category, and **every metric the collector serves must have a case** (or an
 * explicit, written-down exemption). The generated catalog grows by itself when
 * a metric is added to the registry, so without this test a new metric would
 * silently arrive un-evaluated.
 */

import { describe, expect, it } from "vitest";
import { AGENT_SKILL_NAMES, rawTools, readTools } from "@uptimizr/agent-core";
import { CASE_CATEGORIES, loadCases, toolsReferenced } from "../cases.js";
import { coverageReport, loadUncovered } from "../coverage.js";
import { MCP_PROMPT_NAMES, renderMcpPrompt } from "../mcpPrompts.js";

const cases = loadCases();
const uncovered = loadUncovered();
const report = coverageReport(cases, uncovered);

describe("the question bank", () => {
  it("has at least the ~40 cases the sketch calls for", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it("gives every registry category at least one case", () => {
    expect(report.emptyCategories).toEqual([]);
    for (const category of CASE_CATEGORIES) {
      expect(cases.some((c) => c.category === category)).toBe(true);
    }
  });

  it("only names tools the generated catalog actually serves", () => {
    expect(report.unknownTools).toEqual([]);
  });

  it("uses unique, snake_case ids", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9_]+$/);
  });

  it("asks a non-empty question for every case", () => {
    for (const evalCase of cases) expect(evalCase.question.trim().length).toBeGreaterThan(0);
  });

  it("gives every packaged skill at least two cases", () => {
    const perSkill = new Map<string, number>(AGENT_SKILL_NAMES.map((name) => [name, 0]));
    for (const evalCase of cases.filter((c) => c.skill)) {
      const name = evalCase.skill!.name;
      expect(perSkill.has(name), `unknown skill "${name}"`).toBe(true);
      perSkill.set(name, perSkill.get(name)! + 1);
    }
    for (const [name, count] of perSkill) {
      expect(count, `skill "${name}" needs at least two eval cases`).toBeGreaterThanOrEqual(2);
    }
  });

  it("asks each skill exactly what an MCP client would receive", () => {
    // The bank renders a skill through `@uptimizr/agent-core`; `@uptimizr/mcp`
    // renders the same skill as a prompt template. If those two ever diverge,
    // the bank stops measuring what a real client sends — so assert they agree
    // rather than trusting that both read the same array.
    expect([...MCP_PROMPT_NAMES].sort()).toEqual([...AGENT_SKILL_NAMES].sort());
    for (const skillCase of cases.filter((c) => c.skill)) {
      expect(skillCase.question).toBe(
        renderMcpPrompt(skillCase.skill!.name, skillCase.skill!.args),
      );
    }
  });
});

describe("metric coverage", () => {
  it("has a case for every served metric, or a written reason not to", () => {
    expect(report.missing).toEqual([]);
  });

  it("keeps the uncovered allowlist honest", () => {
    // An entry for a metric that is no longer served, or that has since gained a
    // case, is stale — delete it rather than let it hide a future gap.
    expect(report.staleAllowlist).toEqual([]);
  });

  it("covers the whole served catalog between cases and the allowlist", () => {
    // Both catalogs: a capability-gated tool is measured too, through a case
    // that declares `capability: query:raw` (ADR 0051 §7).
    const served = new Set([...readTools, ...rawTools].map((tool) => tool.name));
    const accounted = new Set([...report.covered, ...Object.keys(uncovered)]);
    expect(accounted.size).toBe(served.size);
  });

  it("names at least one tool per case", () => {
    for (const evalCase of cases) {
      expect(toolsReferenced(evalCase).length).toBeGreaterThan(0);
    }
  });
});

describe("capability-gated cases (ADR 0051 §7)", () => {
  it("asks the raw-gated tools only from a query:raw case", () => {
    const rawNames = new Set(rawTools.map((tool) => tool.name));
    for (const evalCase of cases) {
      const usesRaw = toolsReferenced(evalCase).some((name) => rawNames.has(name));
      if (usesRaw) expect(evalCase.capability, evalCase.id).toBe("query:raw");
    }
  });

  it("keeps every other case on the aggregate-only surface", () => {
    const rawCases = cases.filter((evalCase) => evalCase.capability === "query:raw");
    expect(rawCases.length).toBeGreaterThan(0);
    expect(cases.filter((evalCase) => evalCase.capability === "query").length).toBe(
      cases.length - rawCases.length,
    );
  });
});
