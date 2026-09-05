import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { LlmProvider, ProviderRequest, ProviderResponse } from "@uptimizr/agent-core";
import type { CollectorApi } from "../../api";
import { useAssistant } from "../useAssistant";

let nextProvider: LlmProvider;

vi.mock("@uptimizr/agent-core/providers/hosted", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createHostedProvider: () => nextProvider,
}));

/**
 * A provider whose turns the test drives by hand: `push` streams a delta into
 * the in-flight turn and `finish` resolves it, so every intermediate hook
 * state can be observed deterministically. Records the requests it received.
 */
function controlledProvider() {
  const requests: ProviderRequest[] = [];
  let onToken: ((delta: string) => void) | undefined;
  let resolveTurn: ((r: ProviderResponse) => void) | undefined;
  let rejectTurn: ((e: Error) => void) | undefined;
  const provider: LlmProvider = {
    complete: vi.fn(
      (request: ProviderRequest) =>
        new Promise<ProviderResponse>((resolve, reject) => {
          requests.push(request);
          onToken = request.onToken;
          resolveTurn = resolve;
          rejectTurn = reject;
        }),
    ),
  };
  return {
    provider,
    requests,
    /** Stream a delta into the current turn (inside act so React re-renders). */
    push: (delta: string) => act(() => onToken?.(delta)),
    /** Resolve the current turn and let the loop continue / finish. */
    finish: (response: ProviderResponse) =>
      act(async () => {
        resolveTurn?.(response);
        // Let the loop run the next tool call / turn.
        await new Promise((r) => setTimeout(r, 0));
      }),
    fail: (error: Error) =>
      act(async () => {
        rejectTurn?.(error);
        await new Promise((r) => setTimeout(r, 0));
      }),
  };
}

function fakeApi(rows: unknown = []): CollectorApi {
  return { read: vi.fn(async () => rows) } as unknown as CollectorApi;
}

const HOSTED = {
  backend: "hosted" as const,
  hosted: { api: "openai" as const, endpoint: "https://api.example/v1", apiKey: "k", model: "m" },
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useAssistant — streaming", () => {
  it("starts with no partial text and passes an onToken listener to the provider", async () => {
    const stream = controlledProvider();
    nextProvider = stream.provider;
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    expect(result.current.partialText).toBeNull();

    let done!: Promise<void>;
    await act(async () => {
      done = result.current.send("q");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(typeof stream.requests[0]!.onToken).toBe("function");
    await stream.finish({ kind: "final", content: "done" });
    await act(() => done);
  });

  it("exposes the accumulated partial text while a final answer streams", async () => {
    const stream = controlledProvider();
    nextProvider = stream.provider;
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));

    let done!: Promise<void>;
    await act(async () => {
      done = result.current.send("how many sessions?");
      await new Promise((r) => setTimeout(r, 0));
    });
    await stream.push("You ");
    expect(result.current.partialText).toBe("You ");
    await stream.push("had ");
    // Intermediate state: the text so far, the turn still in flight.
    expect(result.current.partialText).toBe("You had ");
    expect(result.current.isBusy).toBe(true);
    // Nothing has been appended to the transcript yet.
    expect(result.current.messages.some((m) => m.role === "assistant")).toBe(false);

    await stream.push("3 sessions.");
    await stream.finish({ kind: "final", content: "You had 3 sessions." });
    await act(() => done);
    // On completion the final turn replaces the partial text in one go.
    expect(result.current.partialText).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({
      role: "assistant",
      content: "You had 3 sessions.",
    });
    expect(result.current.status).toBe("idle");
  });

  it("drops text streamed by a tool-calling turn and streams the answer turn afresh", async () => {
    const stream = controlledProvider();
    nextProvider = stream.provider;
    const { result } = renderHook(() =>
      useAssistant({ api: fakeApi([{ id: "a" }]), backend: HOSTED }),
    );

    let done!: Promise<void>;
    await act(async () => {
      done = result.current.send("q");
      await new Promise((r) => setTimeout(r, 0));
    });
    // Turn 1 streams pre-tool commentary, then asks for a tool.
    await stream.push("Let me check.");
    expect(result.current.partialText).toBe("Let me check.");
    await stream.finish({
      kind: "tool_calls",
      toolCalls: [{ id: "t1", name: "list_sessions", arguments: {} }],
      content: "Let me check.",
    });
    // The tool-call turn ended: its commentary is discarded before the tool runs.
    expect(result.current.partialText).toBeNull();
    expect(stream.requests).toHaveLength(2);

    // Turn 2 streams the real answer from scratch.
    await stream.push("3 ");
    expect(result.current.partialText).toBe("3 ");
    await stream.push("sessions.");
    expect(result.current.partialText).toBe("3 sessions.");
    await stream.finish({ kind: "final", content: "3 sessions." });
    await act(() => done);

    expect(result.current.partialText).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", content: "3 sessions." });
    expect(result.current.toolActivity).toEqual([
      { id: "t1", name: "list_sessions", status: "done" },
    ]);
  });

  it("leaves partialText null for a provider that never streams (unchanged behaviour)", async () => {
    nextProvider = {
      complete: vi.fn(async () => ({ kind: "final", content: "all at once" }) as const),
    };
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    await act(async () => {
      await result.current.send("q");
    });
    expect(result.current.partialText).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", content: "all at once" });
  });

  it("clears partial text when a streaming turn fails", async () => {
    const stream = controlledProvider();
    nextProvider = stream.provider;
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    let done!: Promise<void>;
    await act(async () => {
      done = result.current.send("q");
      await new Promise((r) => setTimeout(r, 0));
    });
    await stream.push("partial ");
    expect(result.current.partialText).toBe("partial ");
    await stream.fail(new Error("boom"));
    await act(() => done);
    expect(result.current.status).toBe("error");
    expect(result.current.partialText).toBeNull();
  });

  it("clears partial text on reset (and on cancel)", async () => {
    const stream = controlledProvider();
    nextProvider = stream.provider;
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    let done!: Promise<void>;
    await act(async () => {
      done = result.current.send("q");
      await new Promise((r) => setTimeout(r, 0));
    });
    await stream.push("x");
    expect(result.current.partialText).toBe("x");
    act(() => result.current.reset());
    expect(result.current.partialText).toBeNull();
    expect(result.current.messages).toEqual([]);
    // The abandoned turn settling later must not resurrect anything.
    await stream.finish({ kind: "final", content: "x" });
    await act(() => done);
    expect(result.current.partialText).toBeNull();
    expect(result.current.status).toBe("idle");
  });
});
