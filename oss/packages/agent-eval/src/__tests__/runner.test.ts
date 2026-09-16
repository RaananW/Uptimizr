/**
 * The end-to-end guarantee the CI gate rests on: every case in the bank, driven
 * through the real `runAgent` loop against the real collector with the scripted
 * provider, passes — and the committed scripted baseline still describes it.
 *
 * This is also what keeps the bank honest. The scripted provider answers from
 * what the collector returned, never from the case's own expectations, so a case
 * whose `expectedAnswer` does not follow from the data it asks for fails here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCases } from "../cases.js";
import { startHarness, type EvalHarness } from "../harness.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { runEval, systemPrompt, type EvalRun } from "../runner.js";
import { gate, loadBaseline } from "../baseline.js";
import { renderJsonReport, renderMarkdownReport } from "../report.js";

describe("the scripted provider over the whole bank", () => {
  let harness: EvalHarness;
  let run: EvalRun;

  beforeAll(async () => {
    harness = await startHarness();
    run = await runEval({
      cases: loadCases(),
      provider: "scripted",
      makeProvider: (evalCase, tools) => createScriptedProvider(evalCase, tools),
      harness,
    });
  }, 600_000);

  afterAll(async () => {
    await harness?.close();
  });

  it("passes every case", () => {
    const failed = run.results.filter((r) => !r.score.passed);
    const detail = failed
      .map(
        (r) =>
          `${r.score.id}: ${[
            ...r.score.tools.failures,
            ...r.score.args.failures,
            ...r.score.answer.failures,
            ...(r.score.error ? [r.score.error] : []),
          ].join("; ")}`,
      )
      .join("\n");
    expect(detail).toBe("");
    expect(run.summary.passRate).toBe(1);
  });

  it("really called the collector for every case", () => {
    for (const result of run.results) {
      expect(result.toolCalls.length).toBeGreaterThan(0);
      expect(result.answer).not.toBe("");
    }
  });

  it("meets the committed scripted baseline", () => {
    const verdict = gate(run, loadBaseline(), "scripted");
    expect(verdict.regressions).toEqual([]);
    expect(verdict.passed).toBe(true);
  });

  it("renders both report artefacts without leaking configuration", () => {
    const markdown = renderMarkdownReport(run);
    expect(markdown).toContain("# Agent evaluation report");
    expect(markdown).toContain("None — every case passed.");
    const json = JSON.parse(renderJsonReport(run)) as EvalRun;
    expect(json.results).toHaveLength(run.results.length);
    expect(JSON.stringify(json)).not.toContain("apiKey");
  });
});

describe("systemPrompt", () => {
  it("states the range and refuses invention", () => {
    const [evalCase] = loadCases();
    const prompt = systemPrompt(evalCase!);
    expect(prompt).toContain("epoch milliseconds");
    expect(prompt).toContain("Never invent a number");
  });

  it("names the scene and session a case is scoped to", () => {
    const scoped = loadCases().find((c) => c.context.scene);
    expect(scoped).toBeDefined();
    expect(systemPrompt(scoped!)).toContain(`scene "${scoped!.context.scene}"`);
  });
});
