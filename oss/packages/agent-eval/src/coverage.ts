/**
 * The coverage rule: **a new metric is not done until it has an eval case**
 * (design sketch §H, mirroring the registry's own coverage test from ADR 0051 §1).
 *
 * The generated tool catalog is derived from the metric registry, so adding an
 * aggregation adds a tool automatically — and, without a rule like this one, adds
 * a tool no question has ever been asked about. This module computes what the
 * bank covers; `src/__tests__/coverage.test.ts` turns the gaps into a build
 * failure unless they are written down in `eval/uncovered.json` with a reason.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readTools } from "@uptimizr/agent-core";
import { CASE_CATEGORIES, toolsReferenced, type CaseCategory, type EvalCase } from "./cases.js";

const uncoveredSchema = z
  .object({
    $comment: z.string().optional(),
    metrics: z.record(z.string(), z.string().min(1)),
  })
  .strict();

/** Path to the committed allowlist of deliberately uncovered metrics. */
export function uncoveredPath(): string {
  return fileURLToPath(new URL("../eval/uncovered.json", import.meta.url));
}

/** Read the allowlist: metric id → why it has no case. */
export function loadUncovered(path: string = uncoveredPath()): Record<string, string> {
  const parsed = uncoveredSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`invalid uncovered allowlist at ${path}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.metrics;
}

/** What the bank does and does not reach. */
export interface CoverageReport {
  /** Every tool the generated catalog serves. */
  served: string[];
  /** Tools named by at least one case. */
  covered: string[];
  /** Served tools with no case and no allowlist entry — these fail the build. */
  missing: string[];
  /** Allowlisted ids that are no longer served, or that now have a case. */
  staleAllowlist: string[];
  /** Cases named in the bank that the catalog does not serve. */
  unknownTools: string[];
  /** Categories with no case at all. */
  emptyCategories: CaseCategory[];
}

/** Compute what the bank covers against the generated catalog. */
export function coverageReport(
  cases: readonly EvalCase[],
  uncovered: Record<string, string>,
): CoverageReport {
  const served = readTools.map((tool) => tool.name);
  const servedSet = new Set(served);
  const referenced = new Set(cases.flatMap((evalCase) => toolsReferenced(evalCase)));
  const withCase = new Set(cases.map((evalCase) => evalCase.category));

  return {
    served,
    covered: served.filter((name) => referenced.has(name)),
    missing: served.filter((name) => !referenced.has(name) && !(name in uncovered)),
    staleAllowlist: Object.keys(uncovered).filter(
      (name) => !servedSet.has(name) || referenced.has(name),
    ),
    unknownTools: [...referenced].filter((name) => !servedSet.has(name)).sort(),
    emptyCategories: CASE_CATEGORIES.filter((category) => !withCase.has(category)),
  };
}
