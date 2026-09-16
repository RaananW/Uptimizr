/**
 * The question bank: its on-disk shape, its validation, and its loader
 * (ADR 0051 §8, design sketch §H).
 *
 * One YAML file per registry category under `cases/`, each holding a list of
 * cases. A case is a question plus everything needed to grade the answer without
 * a human in the loop:
 *
 * - `expectedTools` — a list of **any-of sets**. Every set must be satisfied by
 *   at least one tool the agent actually called, so `[[a, b], [c]]` reads "call
 *   `a` or `b`, and also call `c`". Extra calls are not penalised: there is
 *   usually more than one defensible way to reach an answer.
 * - `expectedArgs` — a **subset** match per tool. Only the arguments listed are
 *   checked; anything else the model passes is its business.
 * - `expectedAnswer` — `numbers` (each with a tolerance), `phrases` that must
 *   appear, and `forbiddenPhrases` that must not. The forbidden list is the
 *   hallucination guard: a wrong metric name or an invented figure fails the
 *   case even when the tool selection was right.
 *
 * Every number in the bank is **derived**, not hand-computed — run
 * `pnpm --filter @uptimizr/agent-eval derive <tool>` and read the row off the
 * real aggregation (design sketch §H).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { renderMcpPrompt } from "./mcpPrompts.js";

/** The registry's metric categories — the bank must span all of them. */
export const CASE_CATEGORIES = [
  "attention",
  "interaction",
  "navigation",
  "performance",
  "errors",
  "xr",
  "ar",
  "sessions",
  "conversion",
] as const;

/** One registry category. */
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

/** Scene/range hints handed to the agent as context for a question. */
const contextSchema = z
  .object({
    scene: z.string().min(1).optional().describe("Scene the question is scoped to."),
    session: z.string().min(1).optional().describe("Session the question is scoped to."),
    since: z
      .number()
      .int()
      .optional()
      .describe("Range start (epoch ms); defaults to the fixtures'."),
    until: z.number().int().optional().describe("Range end (epoch ms); defaults to the fixtures'."),
    note: z.string().optional().describe("Extra prose handed to the agent as context."),
  })
  .strict();

/** A number the answer must contain, within `tolerance` in absolute terms. */
const expectedNumberSchema = z
  .object({
    value: z.number(),
    tolerance: z.number().nonnegative().default(0),
    label: z.string().optional().describe("What the number is, for the report."),
  })
  .strict();

const expectedAnswerSchema = z
  .object({
    numbers: z.array(expectedNumberSchema).default([]),
    phrases: z.array(z.string().min(1)).default([]),
    forbiddenPhrases: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** A reference to one of the curated MCP prompt templates. */
const promptRefSchema = z
  .object({
    name: z.string().min(1),
    args: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const rawCaseSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9_]+$/, "case ids are lower_snake_case"),
    category: z.enum(CASE_CATEGORIES),
    question: z.string().min(1).optional(),
    prompt: promptRefSchema.optional(),
    context: contextSchema.default({}),
    expectedTools: z.array(z.array(z.string().min(1)).min(1)).min(1),
    expectedArgs: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    expectedAnswer: expectedAnswerSchema.default({
      numbers: [],
      phrases: [],
      forbiddenPhrases: [],
    }),
  })
  .strict()
  .refine((c) => (c.question == null) !== (c.prompt == null), {
    message: "a case needs exactly one of `question` or `prompt`",
  });

/** A case exactly as written in YAML. */
export type RawEvalCase = z.infer<typeof rawCaseSchema>;

/** A loaded case: the raw entry with `question` always resolved. */
export interface EvalCase extends Omit<RawEvalCase, "question"> {
  /** The question text put to the agent (rendered when the case is a prompt). */
  question: string;
  /** The YAML file the case came from, for error messages and the report. */
  file: string;
}

/** Every tool named anywhere in a case's `expectedTools`, de-duplicated. */
export function toolsReferenced(evalCase: Pick<EvalCase, "expectedTools">): string[] {
  return [...new Set(evalCase.expectedTools.flat())];
}

/** The default location of the question bank, relative to this package. */
export function defaultCasesDir(): string {
  return fileURLToPath(new URL("../cases/", import.meta.url));
}

/**
 * Load and validate every case in a directory of YAML files. Ids must be unique
 * across the whole bank, a prompt case's text is rendered from the real MCP
 * prompt, and any schema violation throws with the offending file and id — a
 * malformed bank is a build failure, not a silently skipped case.
 */
export function loadCases(dir: string = defaultCasesDir()): EvalCase[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();
  const cases: EvalCase[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const parsed: unknown = parse(readFileSync(join(dir, file), "utf8"));
    const list = z.array(rawCaseSchema).safeParse(parsed);
    if (!list.success) {
      throw new Error(`invalid case file ${file}: ${z.prettifyError(list.error)}`);
    }
    for (const raw of list.data) {
      if (seen.has(raw.id)) throw new Error(`duplicate case id "${raw.id}" (${file})`);
      seen.add(raw.id);
      const question = raw.question ?? renderMcpPrompt(raw.prompt!.name, raw.prompt!.args);
      cases.push({ ...raw, question, file });
    }
  }

  if (cases.length === 0) throw new Error(`no eval cases found in ${dir}`);
  return cases;
}
