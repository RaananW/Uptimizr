/**
 * Ask the bank, record what happened, grade it (ADR 0051 §8).
 *
 * For each case the runner builds a system prompt describing the project and the
 * case's context, drives `runAgent` from `@uptimizr/agent-core` with the
 * **generated** read-tool catalog against the fixture-backed collector, records
 * every tool call and the final answer, and scores the case. One harness is
 * shared by the whole run; one provider is built per case (the scripted provider
 * is case-specific, and a hosted one is stateless so it is simply reused).
 *
 * A case that throws — a provider outage, a rate limit, a malformed tool call —
 * is recorded as a failure with its message rather than aborting the run: a
 * partial report is far more useful than none.
 */

import { runAgent, readTools, type LlmProvider, type ReadTool } from "@uptimizr/agent-core";
import type { AgentMessage } from "@uptimizr/agent-core";
import type { EvalCase } from "./cases.js";
import { EVAL_PROJECT_ID, EVAL_RANGE, EVAL_SCENES } from "./fixtures.js";
import { startHarness, type EvalHarness } from "./harness.js";
import {
  scoreCase,
  summarise,
  type CaseScore,
  type EvalSummary,
  type ObservedRun,
  type ObservedToolCall,
} from "./scoring.js";

/** Cap on provider turns per case — enough for gather-then-answer with retries. */
const MAX_STEPS = 6;

/** The system prompt every case is asked under. */
export function systemPrompt(evalCase: EvalCase): string {
  const { since, until } = EVAL_RANGE;
  const lines = [
    "You are an analytics assistant for a 3D scene. Answer the user's question by " +
      "calling the read-only tools available to you against the project's collector, " +
      "then reply in plain prose.",
    "",
    `Project id: ${EVAL_PROJECT_ID}.`,
    `Scenes in this project: ${Object.values(EVAL_SCENES).join(", ")}.`,
    `Unless the question says otherwise, use the time range since=${evalCase.context.since ?? since} ` +
      `until=${evalCase.context.until ?? until} (epoch milliseconds).`,
  ];
  if (evalCase.context.scene)
    lines.push(`The question is about scene "${evalCase.context.scene}".`);
  if (evalCase.context.session) {
    lines.push(`The question is about session "${evalCase.context.session}".`);
  }
  if (evalCase.context.note) lines.push(evalCase.context.note);
  lines.push(
    "",
    "Report the figures the tools returned. Never invent a number, and say so plainly " +
      "when the data does not answer the question.",
  );
  return lines.join("\n");
}

/** Everything one case produced, kept for the JSON report. */
export interface CaseResult {
  score: CaseScore;
  question: string;
  answer: string;
  toolCalls: ObservedToolCall[];
  /** Provider turns the loop took (0 when the run threw before its first turn). */
  steps: number;
  /** Wall-clock milliseconds the case took. */
  durationMs: number;
}

/** The outcome of a whole bank run. */
export interface EvalRun {
  provider: string;
  /** Model identifier, when the provider has one. */
  model?: string;
  startedAt: string;
  durationMs: number;
  summary: EvalSummary;
  results: CaseResult[];
}

/** How to run the bank. */
export interface RunEvalOptions {
  cases: readonly EvalCase[];
  /** Name recorded in the report (`scripted`, `hosted`, …). */
  provider: string;
  model?: string;
  /** Build the provider for one case. */
  makeProvider: (evalCase: EvalCase, tools: readonly ReadTool[]) => LlmProvider;
  /** Tool catalog to expose; defaults to the full generated catalog. */
  tools?: readonly ReadTool[];
  /** Reuse an already-started harness (tests do); otherwise one is started. */
  harness?: EvalHarness;
  /** Called after each case, for progress output. */
  onCase?: (result: CaseResult, index: number, total: number) => void;
}

/** Pull the tool calls out of a finished transcript, in order. */
function observedCalls(messages: readonly AgentMessage[]): ObservedToolCall[] {
  const calls: ObservedToolCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const call of message.toolCalls) {
      calls.push({ name: call.name, arguments: call.arguments ?? {} });
    }
  }
  return calls;
}

/** Run the whole bank and return the graded result. */
export async function runEval(options: RunEvalOptions): Promise<EvalRun> {
  const tools = options.tools ?? readTools;
  const harness = options.harness ?? (await startHarness());
  const ownsHarness = options.harness === undefined;
  const startedAt = new Date();
  const results: CaseResult[] = [];

  try {
    for (const [index, evalCase] of options.cases.entries()) {
      const began = Date.now();
      let run: ObservedRun;
      try {
        const result = await runAgent({
          provider: options.makeProvider(evalCase, tools),
          client: harness.client,
          tools,
          maxSteps: MAX_STEPS,
          messages: [
            { role: "system", content: systemPrompt(evalCase) },
            { role: "user", content: evalCase.question },
          ],
        });
        run = {
          toolCalls: observedCalls(result.messages),
          answer: result.content,
          steps: result.steps,
        };
      } catch (err) {
        run = {
          toolCalls: [],
          answer: "",
          steps: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const result: CaseResult = {
        score: scoreCase(evalCase, run),
        question: evalCase.question,
        answer: run.answer,
        toolCalls: run.toolCalls,
        steps: run.steps,
        durationMs: Date.now() - began,
      };
      results.push(result);
      options.onCase?.(result, index, options.cases.length);
    }
  } finally {
    if (ownsHarness) await harness.close();
  }

  return {
    provider: options.provider,
    ...(options.model ? { model: options.model } : {}),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    summary: summarise(results.map((r) => r.score)),
    results,
  };
}
