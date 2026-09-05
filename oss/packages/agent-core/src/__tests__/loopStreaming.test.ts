import { describe, expect, it, vi } from "vitest";
import type { CollectorClient } from "../client.js";
import type { LlmProvider, ProviderRequest, ProviderResponse } from "../provider.js";
import { runAgent, type AgentStreamEvent } from "../loop.js";

/**
 * A provider that replays scripted turns. Each turn may stream a list of
 * deltas through `request.onToken` before resolving its response.
 */
function streamingProvider(script: Array<{ deltas?: string[]; response: ProviderResponse }>): {
  provider: LlmProvider;
  requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  let i = 0;
  const provider: LlmProvider = {
    async complete(request) {
      requests.push(request);
      const turn = script[i++];
      if (!turn) throw new Error("scripted provider ran out of turns");
      for (const delta of turn.deltas ?? []) request.onToken?.(delta);
      return turn.response;
    },
  };
  return { provider, requests };
}

const client: CollectorClient = { get: vi.fn(async () => ({ ok: true })) };
const user = (content: string) => ({ role: "user" as const, content });

describe("runAgent — streaming", () => {
  it("passes no onToken to the provider when no onStream observer is given", async () => {
    const { provider, requests } = streamingProvider([
      { deltas: ["ignored"], response: { kind: "final", content: "42." } },
    ]);
    const result = await runAgent({ provider, client, messages: [user("q")] });
    expect(result.content).toBe("42.");
    expect(requests[0]!.onToken).toBeUndefined();
  });

  it("re-emits deltas with the accumulated text and a final turn_end", async () => {
    const { provider } = streamingProvider([
      { deltas: ["You ", "had ", "42."], response: { kind: "final", content: "You had 42." } },
    ]);
    const events: AgentStreamEvent[] = [];
    const result = await runAgent({
      provider,
      client,
      messages: [user("q")],
      onStream: (e) => events.push(e),
    });
    expect(events).toEqual([
      { type: "delta", step: 1, delta: "You ", text: "You " },
      { type: "delta", step: 1, delta: "had ", text: "You had " },
      { type: "delta", step: 1, delta: "42.", text: "You had 42." },
      { type: "turn_end", step: 1, outcome: "final" },
    ]);
    expect(result.content).toBe("You had 42.");
  });

  it("separates a tool-call turn from the final answer turn and keeps the loop intact", async () => {
    const { provider } = streamingProvider([
      {
        deltas: ["Let me check."],
        response: {
          kind: "tool_calls",
          toolCalls: [{ id: "c1", name: "list_sessions", arguments: {} }],
          content: "Let me check.",
        },
      },
      { deltas: ["3 ", "sessions."], response: { kind: "final", content: "3 sessions." } },
    ]);
    const events: AgentStreamEvent[] = [];
    const result = await runAgent({
      provider,
      client,
      messages: [user("q")],
      onStream: (e) => events.push(e),
    });
    expect(events).toEqual([
      { type: "delta", step: 1, delta: "Let me check.", text: "Let me check." },
      { type: "turn_end", step: 1, outcome: "tool_calls" },
      // A fresh turn restarts the accumulated text.
      { type: "delta", step: 2, delta: "3 ", text: "3 " },
      { type: "delta", step: 2, delta: "sessions.", text: "3 sessions." },
      { type: "turn_end", step: 2, outcome: "final" },
    ]);
    expect(client.get).toHaveBeenCalled();
    expect(result.content).toBe("3 sessions.");
    expect(result.steps).toBe(2);
    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: "3 sessions." });
  });

  it("streams the forced synthesis turn as a new turn after an empty final", async () => {
    const { provider, requests } = streamingProvider([
      { response: { kind: "final", content: "" } },
      { deltas: ["forced ", "answer"], response: { kind: "final", content: "forced answer" } },
    ]);
    const events: AgentStreamEvent[] = [];
    const result = await runAgent({
      provider,
      client,
      messages: [user("q")],
      onStream: (e) => events.push(e),
    });
    expect(events).toEqual([
      { type: "turn_end", step: 1, outcome: "final" },
      { type: "delta", step: 1, delta: "forced ", text: "forced " },
      { type: "delta", step: 1, delta: "answer", text: "forced answer" },
      { type: "turn_end", step: 1, outcome: "final" },
    ]);
    // The forced pass still carries a listener and no tools.
    expect(requests[1]!.tools).toEqual([]);
    expect(typeof requests[1]!.onToken).toBe("function");
    expect(result.content).toBe("forced answer");
  });

  it("ignores empty deltas so text never regresses", async () => {
    const { provider } = streamingProvider([
      { deltas: ["", "a", ""], response: { kind: "final", content: "a" } },
    ]);
    const events: AgentStreamEvent[] = [];
    await runAgent({ provider, client, messages: [user("q")], onStream: (e) => events.push(e) });
    expect(events.filter((e) => e.type === "delta")).toHaveLength(1);
  });
});
