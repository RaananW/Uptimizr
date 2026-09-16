/**
 * The committed baseline and the gate that compares a run to it
 * (ADR 0051 §8: "a PR fails the gate when the hosted pass rate drops below the
 * committed baseline by more than a tolerance").
 *
 * `eval/baseline.json` holds one entry per provider: the pass rate the bank
 * reached and the per-case pass state behind it. Two deliberate asymmetries:
 *
 * - The **scripted** baseline is exact. It is deterministic, so any drift at all
 *   is a real change and the gate holds it to 100 %.
 * - The **hosted** baseline is a floor with a tolerance, because a sampled model
 *   is not reproducible run to run. Until a key exists in CI there is no hosted
 *   baseline at all, and the gate says so and passes rather than inventing one:
 *   a missing measurement must never masquerade as a green result.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { EvalRun } from "./runner.js";

/** Default tolerance: how far a hosted pass rate may fall below its baseline. */
export const DEFAULT_HOSTED_TOLERANCE = 0.05;

const providerBaselineSchema = z
  .object({
    /** Pass rate the baseline was recorded at, 0..1. */
    passRate: z.number().min(0).max(1),
    /** Model the baseline was recorded against, when the provider has one. */
    model: z.string().optional(),
    /** When it was recorded (ISO 8601). */
    recordedAt: z.string().optional(),
    /** How far below `passRate` a run may fall before the gate fails. */
    tolerance: z.number().min(0).max(1).default(0),
    /** Per-case pass state at the time of recording. */
    cases: z.record(z.string(), z.boolean()),
  })
  .strict();

const baselineSchema = z
  .object({
    scripted: providerBaselineSchema.optional(),
    hosted: providerBaselineSchema.optional(),
  })
  .strict();

/** One provider's recorded baseline. */
export type ProviderBaseline = z.infer<typeof providerBaselineSchema>;

/** The whole `eval/baseline.json` document. */
export type Baseline = z.infer<typeof baselineSchema>;

/** Path to the committed baseline. */
export function baselinePath(): string {
  return fileURLToPath(new URL("../eval/baseline.json", import.meta.url));
}

/** Read and validate the committed baseline. */
export function loadBaseline(path: string = baselinePath()): Baseline {
  const parsed = baselineSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`invalid baseline at ${path}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Turn a finished run into the baseline entry that would record it. */
export function baselineFromRun(run: EvalRun, tolerance: number): ProviderBaseline {
  const cases: Record<string, boolean> = {};
  for (const result of run.results) cases[result.score.id] = result.score.passed;
  return {
    passRate: Number(run.summary.passRate.toFixed(4)),
    ...(run.model ? { model: run.model } : {}),
    recordedAt: run.startedAt,
    tolerance,
    cases,
  };
}

/** Write the baseline back, Prettier-compatible (2-space JSON + final newline). */
export function writeBaseline(baseline: Baseline, path: string = baselinePath()): void {
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

/** The verdict for one run against the baseline. */
export interface GateVerdict {
  passed: boolean;
  /** One line explaining the verdict, suitable for a CI annotation. */
  reason: string;
  /** Cases that passed in the baseline and fail now. */
  regressions: string[];
  /** Cases that failed in the baseline and pass now. */
  improvements: string[];
}

/**
 * Compare a finished run to the committed baseline for its provider.
 *
 * No baseline for the provider → the run is reported, not judged (this is the
 * "no hosted key yet" path). A baseline present → the run must stay within
 * `tolerance` of the recorded pass rate; per-case regressions are always listed,
 * because "same pass rate, different cases" is worth a reviewer's attention even
 * when the gate lets it through.
 */
export function gate(
  run: EvalRun,
  baseline: Baseline,
  provider: "scripted" | "hosted" = run.provider as "scripted" | "hosted",
): GateVerdict {
  const recorded = baseline[provider];
  const passRate = run.summary.passRate;
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

  if (!recorded) {
    return {
      passed: true,
      reason:
        `no committed baseline for the ${provider} provider — recording ${pct(passRate)} ` +
        "for information only.",
      regressions: [],
      improvements: [],
    };
  }

  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const result of run.results) {
    const before = recorded.cases[result.score.id];
    if (before === undefined) continue;
    if (before && !result.score.passed) regressions.push(result.score.id);
    if (!before && result.score.passed) improvements.push(result.score.id);
  }

  const floor = recorded.passRate - recorded.tolerance;
  if (passRate + 1e-9 < floor) {
    return {
      passed: false,
      reason:
        `${provider} pass rate ${pct(passRate)} is below the baseline ${pct(recorded.passRate)} ` +
        `minus a ${pct(recorded.tolerance)} tolerance (floor ${pct(floor)}).`,
      regressions,
      improvements,
    };
  }

  return {
    passed: true,
    reason:
      `${provider} pass rate ${pct(passRate)} meets the baseline ${pct(recorded.passRate)} ` +
      `(floor ${pct(floor)}).`,
    regressions,
    improvements,
  };
}
