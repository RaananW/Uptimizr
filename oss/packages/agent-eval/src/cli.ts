/**
 * The eval entry point — what CI and a developer both run.
 *
 *   pnpm --filter @uptimizr/agent-eval eval                     # scripted (no key)
 *   pnpm --filter @uptimizr/agent-eval eval -- --provider hosted
 *   pnpm --filter @uptimizr/agent-eval eval -- --provider hosted --update-baseline
 *
 * Exit code is the gate: 0 when the run meets its committed baseline (or has
 * none yet), 1 when it falls below. `--skip-without-key` turns a hosted run with
 * no key into a visible notice and a success, which is how the CI job stays
 * green on a fork or before the secret is configured — a missing measurement is
 * reported, never silently counted as a pass.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCases } from "./cases.js";
import { runEval, type EvalRun } from "./runner.js";
import { createScriptedProvider } from "./providers/scripted.js";
import {
  createHostedProviderFromEnv,
  describeHosted,
  hostedKeyAvailable,
  type ProviderKind,
} from "./providers/index.js";
import {
  DEFAULT_HOSTED_TOLERANCE,
  baselineFromRun,
  gate,
  loadBaseline,
  baselinePath,
  writeBaseline,
} from "./baseline.js";
import { renderJsonReport, renderMarkdownReport } from "./report.js";

interface CliOptions {
  provider: ProviderKind;
  outDir: string;
  updateBaseline: boolean;
  skipWithoutKey: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    provider: "scripted",
    outDir: process.cwd(),
    updateBaseline: false,
    skipWithoutKey: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // pnpm forwards the `--` separator to the script verbatim; it carries no
    // option of its own, so skip it instead of rejecting it.
    if (arg === "--") continue;
    if (arg === "--provider") {
      const value = argv[++i];
      if (value !== "scripted" && value !== "hosted") {
        throw new Error(`--provider must be "scripted" or "hosted" (got ${String(value)})`);
      }
      options.provider = value;
    } else if (arg === "--out") {
      options.outDir = resolve(argv[++i] ?? ".");
    } else if (arg === "--update-baseline") {
      options.updateBaseline = true;
    } else if (arg === "--skip-without-key") {
      options.skipWithoutKey = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return options;
}

function progress(): (
  result: { score: { id: string; passed: boolean } },
  i: number,
  n: number,
) => void {
  return (result, index, total) => {
    const mark = result.score.passed ? "PASS" : "FAIL";
    console.log(`[${String(index + 1).padStart(3)}/${total}] ${mark}  ${result.score.id}`);
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const cases = loadCases();

  if (options.provider === "hosted" && !hostedKeyAvailable(process.env)) {
    const message =
      "Hosted eval skipped: no UPTIMIZR_EVAL_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) " +
      "in the environment, so no hosted run happened and nothing was compared to the baseline.";
    if (options.skipWithoutKey) {
      console.log(`::notice::${message}`);
      return 0;
    }
    console.error(message);
    return 1;
  }

  const model = options.provider === "hosted" ? describeHosted(process.env).model : undefined;
  console.log(
    `Running ${cases.length} eval cases with the ${options.provider} provider` +
      (model ? ` (${model})` : "") +
      "…",
  );

  const hosted =
    options.provider === "hosted" ? createHostedProviderFromEnv(process.env) : undefined;
  const run: EvalRun = await runEval({
    cases,
    provider: options.provider,
    model,
    makeProvider: (evalCase, tools) => hosted ?? createScriptedProvider(evalCase, tools),
    onCase: progress(),
  });

  const baseline = loadBaseline();
  const verdict = gate(run, baseline, options.provider);

  writeFileSync(resolve(options.outDir, "report.md"), renderMarkdownReport(run, verdict), "utf8");
  writeFileSync(resolve(options.outDir, "report.json"), renderJsonReport(run, verdict), "utf8");

  console.log(
    `\n${run.summary.passed}/${run.summary.total} cases passed ` +
      `(${(run.summary.passRate * 100).toFixed(1)}%). Reports written to ${options.outDir}.`,
  );
  console.log(`Gate: ${verdict.passed ? "pass" : "FAIL"} — ${verdict.reason}`);
  if (verdict.regressions.length > 0) {
    console.log(`Regressions vs baseline: ${verdict.regressions.join(", ")}`);
  }

  if (options.updateBaseline) {
    const tolerance = options.provider === "hosted" ? DEFAULT_HOSTED_TOLERANCE : 0;
    writeBaseline({ ...baseline, [options.provider]: baselineFromRun(run, tolerance) });
    console.log(`Baseline updated: ${baselinePath()}`);
    return 0;
  }

  return verdict.passed ? 0 : 1;
}

process.exitCode = await main();
