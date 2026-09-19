/**
 * Token accounting on the provider seam (#312).
 *
 * A scheduled report states what a run cost, which it can only do if the
 * adapters surface what the endpoint reported. The rule asserted here is that
 * `usage` is **absent** when nothing was reported — a consumer must be able to
 * print "not reported by this provider" rather than a misleading zero — and
 * present, normalised, when it was, from both wire formats and both the
 * buffered and streamed paths.
 */

import { describe, expect, it } from "vitest";
import { createAnthropicStreamAssembler, parseAnthropicCompletion } from "../anthropic.js";
import { createOpenAiStreamAssembler, parseOpenAiCompletion } from "../openai.js";

describe("Anthropic usage", () => {
  it("normalises input/output tokens from a buffered response", () => {
    const parsed = parseAnthropicCompletion({
      content: [{ type: "text", text: "42 sessions." }],
      usage: { input_tokens: 1200, output_tokens: 64 },
    });
    expect(parsed).toEqual({
      kind: "final",
      content: "42 sessions.",
      usage: { inputTokens: 1200, outputTokens: 64 },
    });
  });

  it("reports usage alongside tool calls too", () => {
    const parsed = parseAnthropicCompletion({
      content: [{ type: "tool_use", id: "t1", name: "list_sessions", input: {} }],
      usage: { input_tokens: 10 },
    });
    expect(parsed).toMatchObject({ kind: "tool_calls", usage: { inputTokens: 10 } });
    expect(parsed).not.toHaveProperty("usage.outputTokens");
  });

  it("omits usage entirely when the response carried none", () => {
    expect(parseAnthropicCompletion({ content: [{ type: "text", text: "hi" }] })).toEqual({
      kind: "final",
      content: "hi",
    });
  });

  it("assembles usage split across message_start and message_delta", () => {
    const assembler = createAnthropicStreamAssembler();
    assembler.push({ type: "message_start", message: { usage: { input_tokens: 900 } } });
    assembler.push({ type: "content_block_start", index: 0, content_block: { type: "text" } });
    assembler.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    });
    assembler.push({ type: "message_delta", usage: { output_tokens: 32 } });

    expect(parseAnthropicCompletion(assembler.finish())).toEqual({
      kind: "final",
      content: "ok",
      usage: { inputTokens: 900, outputTokens: 32 },
    });
  });

  it("assembles no usage when the stream reported none", () => {
    const assembler = createAnthropicStreamAssembler();
    assembler.push({ type: "content_block_start", index: 0, content_block: { type: "text" } });
    expect(assembler.finish().usage).toBeUndefined();
  });
});

describe("OpenAI usage", () => {
  it("normalises prompt/completion tokens from a buffered response", () => {
    expect(
      parseOpenAiCompletion({
        choices: [{ message: { content: "42 sessions." } }],
        usage: { prompt_tokens: 800, completion_tokens: 20 },
      }),
    ).toEqual({
      kind: "final",
      content: "42 sessions.",
      usage: { inputTokens: 800, outputTokens: 20 },
    });
  });

  it("omits usage entirely when the response carried none", () => {
    expect(parseOpenAiCompletion({ choices: [{ message: { content: "hi" } }] })).toEqual({
      kind: "final",
      content: "hi",
    });
  });

  it("picks usage off a trailing chunk that carries no delta", () => {
    const assembler = createOpenAiStreamAssembler();
    assembler.push({ choices: [{ delta: { content: "ok" } }] });
    assembler.push({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    expect(parseOpenAiCompletion(assembler.finish())).toEqual({
      kind: "final",
      content: "ok",
      usage: { inputTokens: 5, outputTokens: 1 },
    });
  });
});
