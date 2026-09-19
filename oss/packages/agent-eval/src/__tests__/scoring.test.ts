import { describe, expect, it } from "vitest";
import {
  extractNumbers,
  scoreAnswer,
  scoreArgs,
  scoreCase,
  scoreToolSelection,
  summarise,
  type ObservedRun,
} from "../scoring.js";
import type { EvalCase } from "../cases.js";

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "demo",
    category: "performance",
    question: "How is frame rate?",
    file: "performance.yaml",
    context: {},
    capability: "query",
    expectedTools: [["perf_summary"]],
    expectedArgs: {},
    expectedAnswer: { numbers: [], phrases: [], forbiddenPhrases: [] },
    ...overrides,
  };
}

function run(overrides: Partial<ObservedRun> = {}): ObservedRun {
  return { toolCalls: [], answer: "", steps: 1, ...overrides };
}

describe("extractNumbers", () => {
  it("reads integers, decimals and negatives", () => {
    expect(extractNumbers("avg 42.2, min 24, delta -3")).toEqual([42.2, 24, -3]);
  });

  it("treats grouped digits as one number", () => {
    expect(extractNumbers("1,234 triangles and 1 000 vertices")).toEqual([1234, 1000]);
  });

  it("does not swallow a separator that is really punctuation", () => {
    expect(extractNumbers("there were 4, then 5.")).toEqual([4, 5]);
  });

  it("finds nothing in prose without figures", () => {
    expect(extractNumbers("no figures at all here")).toEqual([]);
  });
});

describe("scoreToolSelection", () => {
  it("passes when every any-of set is satisfied", () => {
    const score = scoreToolSelection(
      makeCase({ expectedTools: [["perf_summary", "perf_distribution"], ["jank_rate"]] }),
      run({
        toolCalls: [
          { name: "perf_distribution", arguments: {} },
          { name: "jank_rate", arguments: {} },
        ],
      }),
    );
    expect(score.passed).toBe(true);
    expect(score.score).toBe(1);
  });

  it("does not penalise extra tool calls", () => {
    const score = scoreToolSelection(
      makeCase(),
      run({
        toolCalls: [
          { name: "list_scenes", arguments: {} },
          { name: "perf_summary", arguments: {} },
        ],
      }),
    );
    expect(score.passed).toBe(true);
  });

  it("fails and names the unmet set", () => {
    const score = scoreToolSelection(
      makeCase({ expectedTools: [["perf_summary"], ["jank_rate"]] }),
      run({ toolCalls: [{ name: "perf_summary", arguments: {} }] }),
    );
    expect(score.passed).toBe(false);
    expect(score.score).toBe(0.5);
    expect(score.failures).toEqual(["no call to any of: jank_rate"]);
  });
});

describe("scoreArgs", () => {
  const evalCase = makeCase({ expectedArgs: { perf_summary: { scene: "lobby", limit: 50 } } });

  it("matches a subset — extra arguments are fine", () => {
    const score = scoreArgs(
      evalCase,
      run({
        toolCalls: [
          { name: "perf_summary", arguments: { scene: "lobby", limit: 50, since: 1, until: 2 } },
        ],
      }),
    );
    expect(score.passed).toBe(true);
  });

  it("accepts a numeric argument sent as a string", () => {
    const score = scoreArgs(
      evalCase,
      run({ toolCalls: [{ name: "perf_summary", arguments: { scene: "lobby", limit: "50" } }] }),
    );
    expect(score.passed).toBe(true);
  });

  it("fails on a wrong value and says which argument", () => {
    const score = scoreArgs(
      evalCase,
      run({ toolCalls: [{ name: "perf_summary", arguments: { scene: "arena", limit: 50 } }] }),
    );
    expect(score.passed).toBe(false);
    expect(score.failures[0]).toContain('scene="lobby"');
  });

  it("fails when the tool was never called", () => {
    const score = scoreArgs(evalCase, run({ toolCalls: [] }));
    expect(score.passed).toBe(false);
    expect(score.failures[0]).toContain("never called");
  });

  it("requires one single call to satisfy every argument", () => {
    const score = scoreArgs(
      evalCase,
      run({
        toolCalls: [
          { name: "perf_summary", arguments: { scene: "lobby" } },
          { name: "perf_summary", arguments: { limit: 50 } },
        ],
      }),
    );
    expect(score.passed).toBe(false);
  });
});

describe("scoreAnswer", () => {
  const evalCase = makeCase({
    expectedAnswer: {
      numbers: [{ value: 42.2, tolerance: 0.05, label: "average FPS" }],
      phrases: ["lobby"],
      forbiddenPhrases: ["no data"],
    },
  });

  it("passes on the right figure, the required phrase and no forbidden one", () => {
    const score = scoreAnswer(evalCase, run({ answer: "The lobby averages 42.19 FPS." }));
    expect(score.passed).toBe(true);
  });

  it("fails a figure outside its tolerance", () => {
    const score = scoreAnswer(evalCase, run({ answer: "The lobby averages 45 FPS." }));
    expect(score.passed).toBe(false);
    expect(score.failures[0]).toContain("average FPS 42.2");
  });

  it("fails a missing phrase", () => {
    const score = scoreAnswer(evalCase, run({ answer: "The scene averages 42.2 FPS." }));
    expect(score.failures).toContain('answer is missing the phrase "lobby"');
  });

  it("fails a forbidden phrase, case-insensitively", () => {
    const score = scoreAnswer(
      evalCase,
      run({ answer: "lobby: 42.2 FPS, but No Data after that." }),
    );
    expect(score.failures).toContain('answer contains the forbidden phrase "no data"');
  });

  it("reports an empty answer before anything else", () => {
    const score = scoreAnswer(evalCase, run({ answer: "   " }));
    expect(score.failures[0]).toBe("the run produced no answer");
  });

  it("is vacuously satisfied when nothing is expected", () => {
    expect(scoreAnswer(makeCase(), run({ answer: "" })).passed).toBe(true);
  });
});

describe("scoreCase", () => {
  it("passes only when all three dimensions pass", () => {
    const evalCase = makeCase({
      expectedArgs: { perf_summary: { scene: "lobby" } },
      expectedAnswer: {
        numbers: [{ value: 42.2, tolerance: 0 }],
        phrases: [],
        forbiddenPhrases: [],
      },
    });
    const good = scoreCase(
      evalCase,
      run({
        toolCalls: [{ name: "perf_summary", arguments: { scene: "lobby" } }],
        answer: "42.2 FPS",
      }),
    );
    expect(good.passed).toBe(true);
    expect(good.calledTools).toEqual(["perf_summary"]);

    const badArgs = scoreCase(
      evalCase,
      run({
        toolCalls: [{ name: "perf_summary", arguments: { scene: "arena" } }],
        answer: "42.2 FPS",
      }),
    );
    expect(badArgs.passed).toBe(false);
  });

  it("fails a run that threw, whatever the dimensions say", () => {
    const score = scoreCase(makeCase(), run({ error: "provider timed out" }));
    expect(score.passed).toBe(false);
    expect(score.error).toBe("provider timed out");
  });
});

describe("summarise", () => {
  it("rolls scores up overall and per category", () => {
    const summary = summarise([
      scoreCase(
        makeCase({ id: "a" }),
        run({ toolCalls: [{ name: "perf_summary", arguments: {} }] }),
      ),
      scoreCase(makeCase({ id: "b" }), run({ toolCalls: [] })),
      scoreCase(
        makeCase({ id: "c", category: "xr", expectedTools: [["xr_sources"]] }),
        run({ toolCalls: [{ name: "xr_sources", arguments: {} }] }),
      ),
    ]);
    expect(summary).toEqual({
      total: 3,
      passed: 2,
      passRate: 2 / 3,
      byCategory: {
        performance: { total: 2, passed: 1 },
        xr: { total: 1, passed: 1 },
      },
    });
  });
});
