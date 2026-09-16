/**
 * How a case is graded (ADR 0051 §8, design sketch §H).
 *
 * Three independent dimensions, each pass/fail with a fractional score for the
 * report:
 *
 * 1. **Tool selection** — did the run satisfy every any-of set in
 *    `expectedTools`? Calling extra tools is not penalised; there is usually
 *    more than one defensible route to an answer, and a stricter rule would
 *    grade style rather than correctness.
 * 2. **Arguments** — for each tool named in `expectedArgs`, does *some* call to
 *    that tool carry the listed arguments? Subset match, so a model that also
 *    passes a `limit` is fine.
 * 3. **Answer** — every expected number appears in the final text within its
 *    tolerance, every required phrase appears, no forbidden phrase does.
 *
 * A case passes only when all three do. Nothing here touches a network or a
 * model: scoring is pure over a recorded run, so it is unit-testable and the
 * same function grades the mock, hosted and local-model providers identically.
 */

import type { EvalCase } from "./cases.js";

/** One tool invocation the agent made during a run. */
export interface ObservedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** What a provider run produced for one case. */
export interface ObservedRun {
  /** Tool calls in the order the model asked for them. */
  toolCalls: ObservedToolCall[];
  /** The final natural-language answer (may be empty when the run failed). */
  answer: string;
  /** How many provider turns the loop took. */
  steps: number;
  /** Set when the run threw rather than completing. */
  error?: string;
}

/** The grade for one scoring dimension. */
export interface DimensionScore {
  passed: boolean;
  /** 0..1 — the share of expectations this dimension met. */
  score: number;
  /** Human-readable reasons the dimension did not pass. */
  failures: string[];
}

/** The full grade for one case. */
export interface CaseScore {
  id: string;
  category: string;
  passed: boolean;
  tools: DimensionScore;
  args: DimensionScore;
  answer: DimensionScore;
  /** Tool names the run called, in order (de-duplicated for the report). */
  calledTools: string[];
  /** Propagated from the run when it threw. */
  error?: string;
}

/** Aggregate numbers over a whole run of the bank. */
export interface EvalSummary {
  total: number;
  passed: number;
  /** 0..1 */
  passRate: number;
  byCategory: Record<string, { total: number; passed: number }>;
}

function dimension(met: number, expected: number, failures: string[]): DimensionScore {
  return {
    passed: failures.length === 0,
    score: expected === 0 ? 1 : met / expected,
    failures,
  };
}

/** Did the run satisfy every any-of set? */
export function scoreToolSelection(evalCase: EvalCase, run: ObservedRun): DimensionScore {
  const called = new Set(run.toolCalls.map((c) => c.name));
  const failures: string[] = [];
  let met = 0;
  for (const anyOf of evalCase.expectedTools) {
    if (anyOf.some((name) => called.has(name))) met += 1;
    else failures.push(`no call to any of: ${anyOf.join(" | ")}`);
  }
  return dimension(met, evalCase.expectedTools.length, failures);
}

/**
 * Compare one expected argument value with what the model passed.
 *
 * Numbers compare numerically even across a string/number boundary (a model that
 * sends `"50"` for a numeric parameter picked the right value), and everything
 * else compares by JSON identity so objects and arrays work without a deep-equal
 * dependency.
 */
function argMatches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "number" && (typeof actual === "number" || typeof actual === "string")) {
    return Number(actual) === expected;
  }
  if (typeof expected === "string" && typeof actual === "string") return expected === actual;
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/** Does some call to each named tool carry the expected arguments (subset)? */
export function scoreArgs(evalCase: EvalCase, run: ObservedRun): DimensionScore {
  const failures: string[] = [];
  const entries = Object.entries(evalCase.expectedArgs);
  let met = 0;

  for (const [tool, expected] of entries) {
    const calls = run.toolCalls.filter((c) => c.name === tool);
    if (calls.length === 0) {
      failures.push(`${tool}: never called, so its arguments could not be checked`);
      continue;
    }
    const matching = calls.find((call) =>
      Object.entries(expected).every(([key, value]) => argMatches(value, call.arguments[key])),
    );
    if (matching) {
      met += 1;
      continue;
    }
    const missing = Object.entries(expected)
      .filter(([key, value]) => !calls.some((call) => argMatches(value, call.arguments[key])))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    failures.push(`${tool}: no call carried ${missing.join(", ")}`);
  }

  return dimension(met, entries.length, failures);
}

/**
 * Every number in a block of text, as JS numbers.
 *
 * Scanned character by character rather than with a regular expression: the text
 * is model output, so a backtracking pattern over it would be a ReDoS surface
 * (CodeQL flags exactly this shape). Digit grouping is tolerated — `1,234` and
 * `1 234` both read as 1234 — because models format large counts that way, and a
 * trailing separator that is really punctuation ("…1,234, which…") is dropped.
 */
export function extractNumbers(text: string): number[] {
  const numbers: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const isDigit = ch >= "0" && ch <= "9";
    const negative =
      (ch === "-" || ch === "−") &&
      i + 1 < text.length &&
      text[i + 1]! >= "0" &&
      text[i + 1]! <= "9";
    if (!isDigit && !negative) {
      i += 1;
      continue;
    }
    const start = i;
    if (negative) i += 1;
    let digits = "";
    let seenDot = false;
    while (i < text.length) {
      const c = text[i]!;
      if (c >= "0" && c <= "9") {
        digits += c;
        i += 1;
        continue;
      }
      // A separator only continues the number when digits follow it.
      const next = text[i + 1];
      const followedByDigit = next != null && next >= "0" && next <= "9";
      if ((c === "," || c === " " || c === "_") && followedByDigit && !seenDot) {
        i += 1;
        continue;
      }
      if (c === "." && followedByDigit && !seenDot) {
        seenDot = true;
        digits += ".";
        i += 1;
        continue;
      }
      break;
    }
    if (digits.length > 0 && digits !== ".") {
      const value = Number(digits);
      if (Number.isFinite(value))
        numbers.push(text[start] === "-" || text[start] === "−" ? -value : value);
    }
  }
  return numbers;
}

/** Does the final answer carry the expected figures and wording? */
export function scoreAnswer(evalCase: EvalCase, run: ObservedRun): DimensionScore {
  const { numbers, phrases, forbiddenPhrases } = evalCase.expectedAnswer;
  const failures: string[] = [];
  const expected = numbers.length + phrases.length + forbiddenPhrases.length;
  let met = 0;

  const answer = run.answer;
  const lower = answer.toLowerCase();
  const found = extractNumbers(answer);

  for (const want of numbers) {
    const hit = found.some((n) => Math.abs(n - want.value) <= want.tolerance);
    if (hit) met += 1;
    else {
      const label = want.label ? `${want.label} ` : "";
      const window = want.tolerance > 0 ? ` ±${want.tolerance}` : "";
      failures.push(`answer is missing ${label}${want.value}${window}`);
    }
  }
  for (const phrase of phrases) {
    if (lower.includes(phrase.toLowerCase())) met += 1;
    else failures.push(`answer is missing the phrase "${phrase}"`);
  }
  for (const phrase of forbiddenPhrases) {
    if (!lower.includes(phrase.toLowerCase())) met += 1;
    else failures.push(`answer contains the forbidden phrase "${phrase}"`);
  }

  if (answer.trim() === "" && expected > 0) {
    failures.unshift("the run produced no answer");
  }

  return dimension(met, expected, failures);
}

/** Grade one case against one recorded run. */
export function scoreCase(evalCase: EvalCase, run: ObservedRun): CaseScore {
  const tools = scoreToolSelection(evalCase, run);
  const args = scoreArgs(evalCase, run);
  const answer = scoreAnswer(evalCase, run);
  return {
    id: evalCase.id,
    category: evalCase.category,
    passed: !run.error && tools.passed && args.passed && answer.passed,
    tools,
    args,
    answer,
    calledTools: [...new Set(run.toolCalls.map((c) => c.name))],
    ...(run.error ? { error: run.error } : {}),
  };
}

/** Roll per-case grades up into the headline numbers. */
export function summarise(scores: readonly CaseScore[]): EvalSummary {
  const byCategory: Record<string, { total: number; passed: number }> = {};
  let passed = 0;
  for (const score of scores) {
    const bucket = (byCategory[score.category] ??= { total: 0, passed: 0 });
    bucket.total += 1;
    if (score.passed) {
      bucket.passed += 1;
      passed += 1;
    }
  }
  return {
    total: scores.length,
    passed,
    passRate: scores.length === 0 ? 0 : passed / scores.length,
    byCategory,
  };
}
