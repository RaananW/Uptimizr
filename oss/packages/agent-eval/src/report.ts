/**
 * The run artefacts: `report.md` for a human (and the CI artefact upload) and
 * `report.json` for anything that wants to diff two runs (ADR 0051 §8).
 *
 * The Markdown report leads with the headline pass rate and the per-category
 * table, then lists only what failed and why — a green run stays short, and a
 * red one tells a reviewer which dimension broke (tool selection, arguments, or
 * the answer itself) without opening the JSON.
 *
 * Neither artefact ever contains a provider key: the run records the provider
 * name and model id only, and those are the only fields written here.
 */

import type { EvalRun } from "./runner.js";
import type { GateVerdict } from "./baseline.js";
import type { CaseScore } from "./scoring.js";

/** Escape the pipe characters that would break a Markdown table cell. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function dimensionFailures(score: CaseScore): string[] {
  return [
    ...score.tools.failures.map((f) => `tool selection — ${f}`),
    ...score.args.failures.map((f) => `arguments — ${f}`),
    ...score.answer.failures.map((f) => `answer — ${f}`),
    ...(score.error ? [`run error — ${score.error}`] : []),
  ];
}

/** Render the Markdown report for one run. */
export function renderMarkdownReport(run: EvalRun, verdict?: GateVerdict): string {
  const { summary } = run;
  const lines: string[] = [
    "# Agent evaluation report",
    "",
    `- **Provider:** \`${run.provider}\`${run.model ? ` (model \`${run.model}\`)` : ""}`,
    `- **Cases:** ${summary.passed}/${summary.total} passed (**${pct(summary.passRate)}**)`,
    `- **Started:** ${run.startedAt}`,
    `- **Duration:** ${(run.durationMs / 1000).toFixed(1)}s`,
  ];
  if (verdict) {
    lines.push(`- **Gate:** ${verdict.passed ? "pass" : "FAIL"} — ${verdict.reason}`);
    if (verdict.regressions.length > 0) {
      lines.push(`- **Regressions vs baseline:** ${verdict.regressions.join(", ")}`);
    }
    if (verdict.improvements.length > 0) {
      lines.push(`- **Newly passing:** ${verdict.improvements.join(", ")}`);
    }
  }

  lines.push(
    "",
    "## By category",
    "",
    "| Category | Passed | Total | Pass rate |",
    "| --- | --: | --: | --: |",
  );
  for (const [category, bucket] of Object.entries(summary.byCategory).sort()) {
    lines.push(
      `| ${cell(category)} | ${bucket.passed} | ${bucket.total} | ${pct(bucket.passed / bucket.total)} |`,
    );
  }

  const failures = run.results.filter((r) => !r.score.passed);
  lines.push("", `## Failures (${failures.length})`, "");
  if (failures.length === 0) {
    lines.push("None — every case passed.");
  } else {
    for (const result of failures) {
      lines.push(`### \`${result.score.id}\` (${result.score.category})`, "");
      lines.push(`> ${result.question.split("\n")[0]}`, "");
      lines.push(
        `- Tools called: ${result.score.calledTools.length > 0 ? result.score.calledTools.map((t) => `\`${t}\``).join(", ") : "_none_"}`,
      );
      for (const failure of dimensionFailures(result.score)) lines.push(`- ${cell(failure)}`);
      lines.push("");
    }
  }

  lines.push(
    "## All cases",
    "",
    "| Case | Category | Tools | Args | Answer | Result |",
    "| --- | --- | :-: | :-: | :-: | :-: |",
  );
  for (const result of run.results) {
    const s = result.score;
    const mark = (ok: boolean): string => (ok ? "✅" : "❌");
    lines.push(
      `| \`${cell(s.id)}\` | ${cell(s.category)} | ${mark(s.tools.passed)} | ${mark(s.args.passed)} | ` +
        `${mark(s.answer.passed)} | ${mark(s.passed)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Render the machine-readable report for one run. */
export function renderJsonReport(run: EvalRun, verdict?: GateVerdict): string {
  return `${JSON.stringify({ ...run, ...(verdict ? { gate: verdict } : {}) }, null, 2)}\n`;
}
