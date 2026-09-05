import { describe, expect, it, vi } from "vitest";
import type { ProviderRequest } from "../../provider.js";
import { createWebLlmProvider, type WebLlmEngine, type WebLlmRuntime } from "../webllm.js";
import type { OpenAiCompletion, OpenAiStreamChunk } from "../openai.js";

const TOOL = { name: "top_meshes", description: "ranked meshes", parameters: { type: "object" } };

/** An async iterable of streamed chunks, yielding one per microtask. */
async function* chunks(items: OpenAiStreamChunk[]): AsyncIterable<OpenAiStreamChunk> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

/**
 * A fake engine that returns a streamed iterable for `stream: true` and a
 * plain completion otherwise, recording every request it received.
 */
function fakeEngine(streamed: OpenAiStreamChunk[], completion: OpenAiCompletion) {
  const requests: Array<{ stream?: boolean; tools?: unknown }> = [];
  const interruptGenerate = vi.fn();
  const engine: WebLlmEngine = {
    chat: {
      completions: {
        create: vi.fn(async (request: { stream?: boolean; tools?: unknown }) => {
          requests.push(request);
          return request.stream ? chunks(streamed) : completion;
        }),
      },
    },
    interruptGenerate,
  };
  const runtime: WebLlmRuntime = { CreateMLCEngine: vi.fn(async () => engine) };
  return { requests, interruptGenerate, load: async () => runtime };
}

const delta = (content: string): OpenAiStreamChunk => ({ choices: [{ delta: { content } }] });

describe("WebLLM provider streaming", () => {
  it("streams the tools-less turn: forwards deltas and returns the assembled final", async () => {
    const { requests, load } = fakeEngine(
      [
        delta("The "),
        delta("hero "),
        delta("mesh."),
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      { choices: [{ message: { content: "unused" } }] },
    );
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });
    const tokens: string[] = [];
    const res = await provider.complete({
      messages: [{ role: "user", content: "answer now" }],
      tools: [],
      onToken: (d) => tokens.push(d),
    });
    expect(tokens).toEqual(["The ", "hero ", "mesh."]);
    expect(res).toEqual({ kind: "final", content: "The hero mesh." });
    expect(requests[0]!.stream).toBe(true);
    expect("tools" in requests[0]!).toBe(false);
  });

  it("keeps a tool-calling turn non-streaming (its output is a forced JSON tool-call array)", async () => {
    const { requests, load } = fakeEngine([delta('[{"name":')], {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "0",
                type: "function",
                function: { name: "top_meshes", arguments: '{"limit":5}' },
              },
            ],
          },
        },
      ],
    });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });
    const tokens: string[] = [];
    const request: ProviderRequest = {
      messages: [{ role: "user", content: "top meshes?" }],
      tools: [TOOL],
      onToken: (d) => tokens.push(d),
    };
    const res = await provider.complete(request);
    // No tool-call JSON ever leaks to the token listener.
    expect(tokens).toEqual([]);
    expect(requests[0]!.stream).toBe(false);
    expect(res).toEqual({
      kind: "tool_calls",
      toolCalls: [{ id: "0", name: "top_meshes", arguments: { limit: 5 } }],
    });
  });

  it("does not stream when no listener is supplied (unchanged behaviour)", async () => {
    const { requests, load } = fakeEngine([delta("nope")], {
      choices: [{ message: { content: "plain" } }],
    });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });
    const res = await provider.complete({ messages: [{ role: "user", content: "x" }], tools: [] });
    expect(res).toEqual({ kind: "final", content: "plain" });
    expect(requests[0]!.stream).toBe(false);
  });

  it("interrupts generation and rejects with AbortError when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const { interruptGenerate, load } = fakeEngine([delta("one "), delta("two "), delta("three")], {
      choices: [{ message: { content: "" } }],
    });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });
    const tokens: string[] = [];
    await expect(
      provider.complete({
        messages: [{ role: "user", content: "x" }],
        tools: [],
        signal: controller.signal,
        onToken: (d) => {
          tokens.push(d);
          // Cancel after the first token arrives.
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(tokens).toEqual(["one "]);
    expect(interruptGenerate).toHaveBeenCalledTimes(1);
  });
});
