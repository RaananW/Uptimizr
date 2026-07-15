import { describe, expect, it, vi } from "vitest";
import type { CollectorClient, QueryParams } from "../client.js";
import type { LlmProvider, ProviderRequest, ProviderResponse } from "../provider.js";
import { runAgent, toToolSchemas } from "../loop.js";

/** A provider that returns a fixed, scripted sequence of responses. */
function scriptedProvider(script: ProviderResponse[]): {
  provider: LlmProvider;
  requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  let i = 0;
  const provider: LlmProvider = {
    complete(request) {
      requests.push(request);
      const next = script[i++];
      if (!next) throw new Error("scripted provider ran out of responses");
      return Promise.resolve(next);
    },
  };
  return { provider, requests };
}

/** A fake collector client recording calls and returning canned data. */
function fakeClient(
  handler: (path: string, params?: QueryParams) => unknown = () => ({ ok: true }),
): {
  client: CollectorClient;
  calls: Array<{ path: string; params?: QueryParams }>;
} {
  const calls: Array<{ path: string; params?: QueryParams }> = [];
  const client: CollectorClient = {
    get(path, params) {
      calls.push({ path, params });
      return Promise.resolve(handler(path, params));
    },
  };
  return { client, calls };
}

const user = (content: string) => ({ role: "user" as const, content });

describe("toToolSchemas", () => {
  it("exposes one JSON-schema entry per catalog tool", () => {
    const schemas = toToolSchemas();
    expect(schemas.length).toBeGreaterThan(0);
    const pointer = schemas.find((s) => s.name === "pointer_heatmap");
    expect(pointer).toBeDefined();
    expect(pointer!.description).toContain("pointer");
    const params = pointer!.parameters as { type: string; properties: Record<string, unknown> };
    expect(params.type).toBe("object");
    expect(Object.keys(params.properties)).toContain("bins");
  });
});

describe("runAgent", () => {
  it("returns immediately when the provider gives a final answer", async () => {
    const { provider, requests } = scriptedProvider([{ kind: "final", content: "42 sessions." }]);
    const { client, calls } = fakeClient();

    const result = await runAgent({ provider, client, messages: [user("how many?")] });

    expect(result.content).toBe("42 sessions.");
    expect(result.steps).toBe(1);
    expect(result.stoppedOnMaxSteps).toBe(false);
    expect(calls).toHaveLength(0);
    expect(requests[0]!.tools.length).toBeGreaterThan(0);
    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "42 sessions." });
  });

  it("executes a tool call, feeds the result back, then returns the final answer", async () => {
    const { provider } = scriptedProvider([
      {
        kind: "tool_calls",
        toolCalls: [{ id: "c1", name: "list_sessions", arguments: { limit: 5 } }],
      },
      { kind: "final", content: "Found 2 sessions." },
    ]);
    const { client, calls } = fakeClient(() => [{ id: "s1" }, { id: "s2" }]);

    const result = await runAgent({ provider, client, messages: [user("recent sessions?")] });

    expect(calls).toEqual([
      { path: "api/v1/sessions", params: { since: undefined, until: undefined, limit: 5 } },
    ]);
    expect(result.steps).toBe(2);
    expect(result.content).toBe("Found 2 sessions.");
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ toolCallId: "c1", name: "list_sessions" });
    expect(toolMsg!.content).toBe(JSON.stringify([{ id: "s1" }, { id: "s2" }]));
  });

  it("runs several tool calls in a single turn", async () => {
    const { provider } = scriptedProvider([
      {
        kind: "tool_calls",
        toolCalls: [
          { id: "a", name: "perf_summary", arguments: {} },
          { id: "b", name: "list_scenes", arguments: { limit: 3 } },
        ],
      },
      { kind: "final", content: "done" },
    ]);
    const { client, calls } = fakeClient();

    const result = await runAgent({ provider, client, messages: [user("summary")] });

    expect(calls.map((c) => c.path)).toEqual(["api/v1/perf", "api/v1/scenes"]);
    const toolResults = result.messages.filter((m) => m.role === "tool");
    expect(toolResults.map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["a", "b"]);
  });

  it("reports an error for an unknown tool without calling the collector", async () => {
    const { provider } = scriptedProvider([
      { kind: "tool_calls", toolCalls: [{ id: "x", name: "delete_everything", arguments: {} }] },
      { kind: "final", content: "cannot do that" },
    ]);
    const { client, calls } = fakeClient();

    const result = await runAgent({ provider, client, messages: [user("drop data")] });

    expect(calls).toHaveLength(0);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg!.content).toMatch(/unknown tool "delete_everything"/);
  });

  it("reports invalid arguments and never queries the collector", async () => {
    const { provider } = scriptedProvider([
      {
        kind: "tool_calls",
        // scene_representation requires a non-empty sceneId string.
        toolCalls: [{ id: "x", name: "scene_representation", arguments: { sceneId: "" } }],
      },
      { kind: "final", content: "please provide a scene" },
    ]);
    const { client, calls } = fakeClient();

    const result = await runAgent({ provider, client, messages: [user("scene")] });

    expect(calls).toHaveLength(0);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg!.content).toMatch(/invalid arguments for "scene_representation"/);
  });

  it("surfaces a collector error as a tool result and keeps going", async () => {
    const { provider } = scriptedProvider([
      { kind: "tool_calls", toolCalls: [{ id: "c1", name: "perf_summary", arguments: {} }] },
      { kind: "final", content: "the collector is down" },
    ]);
    const client: CollectorClient = {
      get: vi.fn(() => Promise.reject(new Error("boom"))),
    };

    const result = await runAgent({ provider, client, messages: [user("perf?")] });

    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg!.content).toBe("Error: boom");
    expect(result.content).toBe("the collector is down");
  });

  it("stops at maxSteps if the provider never finalises", async () => {
    const loopingProvider: LlmProvider = {
      complete: () =>
        Promise.resolve({
          kind: "tool_calls",
          toolCalls: [{ id: "c", name: "perf_summary", arguments: {} }],
        }),
    };
    const { client, calls } = fakeClient();

    const result = await runAgent({
      provider: loopingProvider,
      client,
      messages: [user("loop")],
      maxSteps: 3,
    });

    expect(result.steps).toBe(3);
    expect(result.stoppedOnMaxSteps).toBe(true);
    expect(result.content).toBe("");
    expect(calls).toHaveLength(3);
  });

  it("forwards the abort signal to the provider", async () => {
    const controller = new AbortController();
    const { provider, requests } = scriptedProvider([{ kind: "final", content: "ok" }]);
    const { client } = fakeClient();

    await runAgent({
      provider,
      client,
      messages: [user("hi")],
      signal: controller.signal,
    });

    expect(requests[0]!.signal).toBe(controller.signal);
  });
});
