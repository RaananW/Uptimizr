import { describe, expect, it, vi } from "vitest";
import type { ProviderRequest } from "../provider.js";
import { createHostedProvider, HostedProviderError } from "../hosted.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const request: ProviderRequest = {
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "how many sessions?" },
  ],
  tools: [
    { name: "list_sessions", description: "recent sessions", parameters: { type: "object" } },
  ],
};

describe("hosted provider — OpenAI-compatible", () => {
  it("POSTs an OpenAI chat-completion and parses a final answer", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "42 sessions." } }] }),
    );
    const provider = createHostedProvider({
      api: "openai",
      endpoint: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await provider.complete(request);

    expect(res).toEqual({ kind: "final", content: "42 sessions." });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-test" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-x");
    expect(body.tools[0].function.name).toBe("list_sessions");
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "how many sessions?" },
    ]);
  });

  it("parses tool calls with JSON-string arguments", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "list_sessions", arguments: '{"limit":5}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = createHostedProvider({
      api: "openai",
      endpoint: "https://api.example.com/v1/",
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await provider.complete(request);

    expect(res).toEqual({
      kind: "tool_calls",
      toolCalls: [{ id: "call_1", name: "list_sessions", arguments: { limit: 5 } }],
    });
    // Trailing slash on endpoint is normalised, not doubled.
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.example.com/v1/chat/completions");
  });

  it("throws HostedProviderError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const provider = createHostedProvider({
      api: "openai",
      endpoint: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.complete(request)).rejects.toBeInstanceOf(HostedProviderError);
  });

  it("trims trailing slashes in linear time (no ReDoS on pathological endpoints)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    // A user-supplied endpoint with a huge run of trailing slashes must not
    // trigger polynomial backtracking (js/polynomial-redos).
    const endpoint = `https://api.example.com/v1${"/".repeat(100_000)}`;
    const provider = createHostedProvider({
      api: "openai",
      endpoint,
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const start = Date.now();
    await provider.complete(request);
    expect(Date.now() - start).toBeLessThan(1000);
    // All trailing slashes collapsed, single well-known suffix appended.
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.example.com/v1/chat/completions");
  });
});

describe("hosted provider — Anthropic", () => {
  it("POSTs an Anthropic message with the browser-access header and system prompt", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [{ type: "text", text: "hello" }] }),
    );
    const provider = createHostedProvider({
      api: "anthropic",
      endpoint: "https://api.anthropic.com/v1",
      apiKey: "ak-test",
      model: "claude-x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await provider.complete(request);

    expect(res).toEqual({ kind: "final", content: "hello" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init as RequestInit).headers).toMatchObject({
      "x-api-key": "ak-test",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("claude-x");
    expect(body.max_tokens).toBe(1024);
    expect(body.system).toBe("be brief");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "how many sessions?" }] },
    ]);
    expect(body.tools[0]).toMatchObject({ name: "list_sessions" });
  });

  it("parses Anthropic tool_use blocks into tool calls", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "tu_1", name: "list_sessions", input: { limit: 3 } },
        ],
      }),
    );
    const provider = createHostedProvider({
      api: "anthropic",
      endpoint: "https://api.anthropic.com/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await provider.complete(request);

    expect(res).toEqual({
      kind: "tool_calls",
      toolCalls: [{ id: "tu_1", name: "list_sessions", arguments: { limit: 3 } }],
      content: "checking",
    });
  });
});
