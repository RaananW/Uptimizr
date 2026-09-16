import { describe, expect, it } from "vitest";
import { baselineFromRun, gate, loadBaseline, type Baseline } from "../baseline.js";
import type { EvalRun } from "../runner.js";
import type { CaseScore } from "../scoring.js";

function score(id: string, passed: boolean): CaseScore {
  const dimension = { passed, score: passed ? 1 : 0, failures: [] };
  return {
    id,
    category: "performance",
    passed,
    tools: dimension,
    args: dimension,
    answer: dimension,
    calledTools: [],
  };
}

function makeRun(provider: string, states: Record<string, boolean>, model?: string): EvalRun {
  const results = Object.entries(states).map(([id, passed]) => ({
    score: score(id, passed),
    question: id,
    answer: "",
    toolCalls: [],
    steps: 2,
    durationMs: 1,
  }));
  const passed = results.filter((r) => r.score.passed).length;
  return {
    provider,
    ...(model ? { model } : {}),
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 10,
    summary: {
      total: results.length,
      passed,
      passRate: results.length === 0 ? 0 : passed / results.length,
      byCategory: { performance: { total: results.length, passed } },
    },
    results,
  };
}

describe("the committed baseline", () => {
  it("parses and pins the scripted provider at 100% with no tolerance", () => {
    const baseline = loadBaseline();
    expect(baseline.scripted?.passRate).toBe(1);
    expect(baseline.scripted?.tolerance).toBe(0);
  });

  it("has no hosted entry until a hosted run has actually happened", () => {
    // A hosted baseline invented without a hosted run would let the gate report
    // a measurement nobody made. Absent is the honest state.
    expect(loadBaseline().hosted).toBeUndefined();
  });
});

describe("gate", () => {
  const baseline: Baseline = {
    hosted: {
      passRate: 0.8,
      tolerance: 0.05,
      cases: { a: true, b: true, c: false },
    },
  };

  it("reports, but does not judge, a provider with no baseline", () => {
    const verdict = gate(makeRun("scripted", { a: false }), baseline, "scripted");
    expect(verdict.passed).toBe(true);
    expect(verdict.reason).toContain("no committed baseline");
  });

  it("passes a run exactly on the tolerance floor", () => {
    // 3/4 = 75%, which is the 80% baseline minus its 5-point tolerance.
    const verdict = gate(
      makeRun("hosted", { a: true, b: true, c: true, d: false }),
      baseline,
      "hosted",
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.improvements).toEqual(["c"]);
  });

  it("fails a run below the baseline minus the tolerance", () => {
    const verdict = gate(makeRun("hosted", { a: true, b: false, c: false }), baseline, "hosted");
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("below the baseline");
    expect(verdict.regressions).toEqual(["b"]);
  });

  it("lists per-case movement even when the rate holds", () => {
    const verdict = gate(makeRun("hosted", { a: true, b: false, c: true }), baseline, "hosted");
    expect(verdict.regressions).toEqual(["b"]);
    expect(verdict.improvements).toEqual(["c"]);
  });

  it("ignores cases the baseline has never seen", () => {
    const verdict = gate(
      makeRun("hosted", { a: true, b: true, c: true, z: false }),
      baseline,
      "hosted",
    );
    expect(verdict.regressions).toEqual([]);
  });
});

describe("baselineFromRun", () => {
  it("records the pass rate, the model and the per-case state", () => {
    const entry = baselineFromRun(
      makeRun("hosted", { a: true, b: false }, "claude-sonnet-5"),
      0.05,
    );
    expect(entry).toMatchObject({
      passRate: 0.5,
      model: "claude-sonnet-5",
      tolerance: 0.05,
      cases: { a: true, b: false },
    });
  });
});
