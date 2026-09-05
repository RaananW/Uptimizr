import { describe, expect, it } from "vitest";
import { createOpenAiStreamAssembler, parseOpenAiCompletion } from "../openai.js";
import { createAnthropicStreamAssembler, parseAnthropicCompletion } from "../anthropic.js";

describe("createOpenAiStreamAssembler", () => {
  it("concatenates text deltas and returns each as it is pushed", () => {
    const a = createOpenAiStreamAssembler();
    expect(a.push({ choices: [{ delta: { role: "assistant" } as never }] })).toBe("");
    expect(a.push({ choices: [{ delta: { content: "42 " } }] })).toBe("42 ");
    expect(a.push({ choices: [{ delta: { content: "sessions." } }] })).toBe("sessions.");
    expect(a.push({ choices: [{ delta: {}, finish_reason: "stop" }] })).toBe("");
    expect(parseOpenAiCompletion(a.finish())).toEqual({ kind: "final", content: "42 sessions." });
  });

  it("assembles tool-call deltas by index (id + name first, arguments appended)", () => {
    const a = createOpenAiStreamAssembler();
    a.push({
      choices: [
        {
          delta: {
            content: null,
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "list_", arguments: "" },
              },
            ],
          },
        },
      ],
    });
    a.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "sessions" } }] } }],
    });
    a.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"lim' } }] } }],
    });
    // A second, interleaved call on index 1.
    a.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 1, id: "call_2", function: { name: "top_meshes", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    a.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'it":5}' } }] } }],
    });
    expect(parseOpenAiCompletion(a.finish())).toEqual({
      kind: "tool_calls",
      toolCalls: [
        { id: "call_1", name: "list_sessions", arguments: { limit: 5 } },
        { id: "call_2", name: "top_meshes", arguments: {} },
      ],
    });
  });

  it("synthesises WebLLM-style ids (the index) when streamed tool calls omit `id`", () => {
    const a = createOpenAiStreamAssembler();
    a.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                type: "function",
                function: { name: "top_meshes", arguments: '{"limit":3}' },
              },
              { index: 1, type: "function", function: { name: "perf_summary", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    expect(parseOpenAiCompletion(a.finish())).toEqual({
      kind: "tool_calls",
      toolCalls: [
        { id: "0", name: "top_meshes", arguments: { limit: 3 } },
        { id: "1", name: "perf_summary", arguments: {} },
      ],
    });
  });

  it("keeps pre-tool commentary as `content` on a tool-call turn", () => {
    const a = createOpenAiStreamAssembler();
    a.push({ choices: [{ delta: { content: "Let me check." } }] });
    a.push({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: "{}" } }] },
        },
      ],
    });
    expect(parseOpenAiCompletion(a.finish())).toMatchObject({
      kind: "tool_calls",
      content: "Let me check.",
    });
  });

  it("tolerates chunks with no choices", () => {
    const a = createOpenAiStreamAssembler();
    expect(a.push({})).toBe("");
    expect(a.push({ choices: [] })).toBe("");
    expect(parseOpenAiCompletion(a.finish())).toEqual({ kind: "final", content: "" });
  });
});

describe("createAnthropicStreamAssembler", () => {
  it("assembles text_delta events into the final answer", () => {
    const a = createAnthropicStreamAssembler();
    expect(a.push({ type: "message_start" })).toBe("");
    expect(
      a.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ).toBe("");
    expect(a.push({ type: "ping" })).toBe("");
    expect(
      a.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } }),
    ).toBe("hel");
    expect(
      a.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
    ).toBe("lo");
    a.push({ type: "content_block_stop", index: 0 });
    a.push({ type: "message_delta" });
    a.push({ type: "message_stop" });
    expect(parseAnthropicCompletion(a.finish())).toEqual({ kind: "final", content: "hello" });
  });

  it("assembles a tool_use block from input_json_delta fragments, keeping leading text", () => {
    const a = createAnthropicStreamAssembler();
    a.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    a.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "checking" },
    });
    a.push({ type: "content_block_stop", index: 0 });
    a.push({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_1", name: "list_sessions" },
    });
    expect(
      a.push({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"lim' },
      }),
    ).toBe("");
    a.push({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: 'it": 3}' },
    });
    a.push({ type: "content_block_stop", index: 1 });
    expect(parseAnthropicCompletion(a.finish())).toEqual({
      kind: "tool_calls",
      toolCalls: [{ id: "tu_1", name: "list_sessions", arguments: { limit: 3 } }],
      content: "checking",
    });
  });

  it("treats an empty or malformed tool input as {} and orders blocks by index", () => {
    const a = createAnthropicStreamAssembler();
    a.push({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_b", name: "b" },
    });
    a.push({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{oops" },
    });
    a.push({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu_a", name: "a" },
    });
    expect(parseAnthropicCompletion(a.finish())).toEqual({
      kind: "tool_calls",
      toolCalls: [
        { id: "tu_a", name: "a", arguments: {} },
        { id: "tu_b", name: "b", arguments: {} },
      ],
    });
  });

  it("accepts a text_delta for a block that never announced a start", () => {
    const a = createAnthropicStreamAssembler();
    expect(a.push({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } })).toBe(
      "x",
    );
    expect(parseAnthropicCompletion(a.finish())).toEqual({ kind: "final", content: "x" });
  });
});
