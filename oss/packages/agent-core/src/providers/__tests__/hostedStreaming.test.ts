import { describe, expect, it, vi } from "vitest";
import type { ProviderRequest } from "../../provider.js";
import { createHostedProvider, HostedProviderError } from "../hosted.js";

/**
 * A fake `text/event-stream` response whose body yields the given string
 * chunks as SEPARATE reads (so chunk boundaries land mid-line / mid-event, as
 * they do on a real network).
 */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
      else controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const request: ProviderRequest = {
  messages: [{ role: "user", content: "how many sessions?" }],
  tools: [
    { name: "list_sessions", description: "recent sessions", parameters: { type: "object" } },
  ],
};

function openaiProvider(fetchImpl: unknown) {
  return createHostedProvider({
    api: "openai",
    endpoint: "https://api.example.com/v1",
    apiKey: "k",
    model: "m",
    fetchImpl: fetchImpl as typeof fetch,
  });
}

function anthropicProvider(fetchImpl: unknown) {
  return createHostedProvider({
    api: "anthropic",
    endpoint: "https://api.anthropic.com/v1",
    apiKey: "k",
    model: "m",
    fetchImpl: fetchImpl as typeof fetch,
  });
}

/** Build an OpenAI `data:` line for a content delta. */
const oaDelta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe("hosted provider streaming — OpenAI-compatible", () => {
  it("does not request a stream when no onToken listener is supplied", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "42." } }] }),
    );
    const res = await openaiProvider(fetchImpl).complete(request);
    expect(res).toEqual({ kind: "final", content: "42." });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect("stream" in body).toBe(false);
  });

  it("requests stream:true, forwards each delta in order and returns the assembled final", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        // Chunk boundaries fall mid-event and mid-line on purpose.
        oaDelta("You ").slice(0, 20),
        oaDelta("You ").slice(20) + oaDelta("had ").slice(0, 5),
        oaDelta("had ").slice(5) + oaDelta("42 sessions."),
        "data: [DONE]\n\n",
      ]),
    );
    const tokens: string[] = [];
    const res = await openaiProvider(fetchImpl).complete({
      ...request,
      onToken: (d) => tokens.push(d),
    });
    expect(tokens).toEqual(["You ", "had ", "42 sessions."]);
    expect(res).toEqual({ kind: "final", content: "You had 42 sessions." });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
  });

  it("assembles streamed tool-call deltas into tool calls without emitting them as text", async () => {
    const chunk = (toolCall: unknown) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: null, tool_calls: [toolCall] } }] })}\n\n`;
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        chunk({
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "list_sessions", arguments: "" },
        }),
        chunk({ index: 0, function: { arguments: '{"li' } }),
        chunk({ index: 0, function: { arguments: 'mit":5}' } }),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );
    const tokens: string[] = [];
    const res = await openaiProvider(fetchImpl).complete({
      ...request,
      onToken: (d) => tokens.push(d),
    });
    expect(tokens).toEqual([]);
    expect(res).toEqual({
      kind: "tool_calls",
      toolCalls: [{ id: "call_1", name: "list_sessions", arguments: { limit: 5 } }],
    });
  });

  it("falls back to the JSON body (one delta) when the provider ignores stream:true", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "whole answer" } }] }),
    );
    const tokens: string[] = [];
    const res = await openaiProvider(fetchImpl).complete({
      ...request,
      onToken: (d) => tokens.push(d),
    });
    expect(tokens).toEqual(["whole answer"]);
    expect(res).toEqual({ kind: "final", content: "whole answer" });
  });

  it("skips malformed data lines and keep-alive comments without dropping the stream", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([": keep-alive\n\n", "data: {not json\n\n", oaDelta("ok"), "data: [DONE]\n\n"]),
    );
    const tokens: string[] = [];
    const res = await openaiProvider(fetchImpl).complete({
      ...request,
      onToken: (d) => tokens.push(d),
    });
    expect(tokens).toEqual(["ok"]);
    expect(res).toEqual({ kind: "final", content: "ok" });
  });

  it("still throws HostedProviderError on a non-2xx response when streaming", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    await expect(
      openaiProvider(fetchImpl).complete({ ...request, onToken: () => {} }),
    ).rejects.toMatchObject({ name: "HostedProviderError", status: 429 });
  });
});

describe("hosted provider streaming — Anthropic", () => {
  const ev = (type: string, payload: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

  it("requests stream:true, forwards text_deltas and returns the assembled final", async () => {
    const stream = [
      ev("message_start", { message: { id: "msg_1" } }),
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      ev("ping", {}),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hel" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "lo" } }),
      ev("content_block_stop", { index: 0 }),
      ev("message_delta", { delta: { stop_reason: "end_turn" } }),
      ev("message_stop", {}),
    ].join("");
    // Deliver in uneven slices so events straddle reads.
    const fetchImpl = vi.fn(async () =>
      sseResponse([stream.slice(0, 70), stream.slice(70, 210), stream.slice(210)]),
    );
    const tokens: string[] = [];
    const res = await anthropicProvider(fetchImpl).complete({
      ...request,
      onToken: (d) => tokens.push(d),
    });
    expect(tokens).toEqual(["hel", "lo"]);
    expect(res).toEqual({ kind: "final", content: "hello" });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
  });

  it("assembles a streamed tool_use block (input_json_delta) into a tool call", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "checking" } }),
        ev("content_block_start", {
          index: 1,
          content_block: { type: "tool_use", id: "tu_1", name: "list_sessions", input: {} },
        }),
        ev("content_block_delta", {
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"limit"' },
        }),
        ev("content_block_delta", {
          index: 1,
          delta: { type: "input_json_delta", partial_json: ": 3}" },
        }),
        ev("content_block_stop", { index: 1 }),
        ev("message_stop", {}),
      ]),
    );
    const tokens: string[] = [];
    const res = await anthropicProvider(fetchImpl).complete({
      ...request,
      onToken: (d) => tokens.push(d),
    });
    expect(tokens).toEqual(["checking"]);
    expect(res).toEqual({
      kind: "tool_calls",
      toolCalls: [{ id: "tu_1", name: "list_sessions", arguments: { limit: 3 } }],
      content: "checking",
    });
  });

  it("surfaces a mid-stream `error` event as HostedProviderError", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "par" } }),
        ev("error", { error: { type: "overloaded_error", message: "Overloaded" } }),
      ]),
    );
    await expect(
      anthropicProvider(fetchImpl).complete({ ...request, onToken: () => {} }),
    ).rejects.toBeInstanceOf(HostedProviderError);
  });

  it("falls back to the JSON body when the endpoint does not stream", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    const tokens: string[] = [];
    const res = await anthropicProvider(fetchImpl).complete({
      ...request,
      onToken: (d) => tokens.push(d),
    });
    expect(tokens).toEqual(["hi"]);
    expect(res).toEqual({ kind: "final", content: "hi" });
  });
});
