import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { BACKEND_CONFIG_STORAGE_KEY, saveBackendConfig } from "@uptimizr/agent-core/providers";
import type { LlmProvider, ProviderResponse } from "@uptimizr/agent-core";
import { coreReadTools, readTools } from "@uptimizr/agent-core";
import type { CollectorApi } from "../../api";
import { useAssistant } from "../useAssistant";

// Control the provider each factory subpath hands back, and capture what config
// the hook passed in. Only the FACTORY subpaths are mocked — the lightweight
// config/detection barrel runs for real (pure, no network).
let nextProvider: LlmProvider;
let lastWebllmOptions: unknown;
// The cache-clearing helper is mocked too: the real one imports the WebLLM
// runtime and touches the browser Cache API, neither of which exists here.
const clearCachedModelsMock = vi.fn(async (): Promise<string[]> => []);

vi.mock("@uptimizr/agent-core/providers/webllm", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createWebLlmProvider: (options: unknown) => {
    lastWebllmOptions = options;
    return nextProvider;
  },
  clearCachedModels: (...args: unknown[]) => clearCachedModelsMock(...(args as [])),
}));
vi.mock("@uptimizr/agent-core/providers/hosted", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createHostedProvider: () => nextProvider,
}));

/** A provider that replays a fixed script of responses, one per turn. */
function scriptedProvider(steps: ProviderResponse[]): LlmProvider {
  let i = 0;
  return { complete: vi.fn(async () => steps[i++] ?? { kind: "final", content: "" }) };
}

/** A fake collector client that records reads and never touches the network. */
function fakeApi(rows: unknown = []): CollectorApi & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async () => rows) } as unknown as CollectorApi & {
    read: ReturnType<typeof vi.fn>;
  };
}

const HOSTED = {
  backend: "hosted" as const,
  hosted: { api: "openai" as const, endpoint: "https://api.example/v1", apiKey: "k", model: "m" },
};

beforeEach(() => {
  lastWebllmOptions = undefined;
  clearCachedModelsMock.mockReset();
  clearCachedModelsMock.mockResolvedValue([]);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useAssistant", () => {
  it("stays unselected (null) with no explicit and no persisted backend", () => {
    // First run: no auto-preselect, so the UI can present an explicit chooser and
    // NOTHING loads (no provider factory is invoked just by mounting).
    const { result } = renderHook(() => useAssistant({ api: fakeApi() }));
    expect(result.current.backend).toBeNull();
    expect(result.current.isReady).toBe(false);
    expect(lastWebllmOptions).toBeUndefined();
  });

  it("restores a previously persisted backend choice (no re-prompt)", () => {
    saveBackendConfig(HOSTED);
    const { result } = renderHook(() => useAssistant({ api: fakeApi() }));
    expect(result.current.backend).toEqual(HOSTED);
  });

  it("honors an explicit options.backend over any persisted choice", () => {
    saveBackendConfig({ backend: "local", webllm: { model: "persisted" } });
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    expect(result.current.backend).toEqual(HOSTED);
  });

  it("runs a tool-call round-trip through the injected collector client", async () => {
    nextProvider = scriptedProvider([
      { kind: "tool_calls", toolCalls: [{ id: "t1", name: "list_sessions", arguments: {} }] },
      { kind: "final", content: "You had 3 sessions." },
    ]);
    const api = fakeApi([{ session_id: "a" }]);
    const { result } = renderHook(() => useAssistant({ api, backend: HOSTED }));

    await act(async () => {
      await result.current.send("how many sessions?");
    });

    // The tool call executed against the reused collector client (its path).
    expect(api.read).toHaveBeenCalledWith("api/v1/sessions", expect.any(Object));
    // The final answer is appended and surfaced.
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "You had 3 sessions.",
    });
    // Tool-call progress resolved to done.
    expect(result.current.toolActivity).toEqual([
      { id: "t1", name: "list_sessions", status: "done" },
    ]);
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("keeps the system prompt first and preserves history across turns", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "hi" }]);
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));

    await act(async () => {
      await result.current.send("first");
    });
    expect(result.current.messages[0]).toMatchObject({ role: "system" });
    expect(result.current.messages.some((m) => m.role === "user" && m.content === "first")).toBe(
      true,
    );

    nextProvider = scriptedProvider([{ kind: "final", content: "again" }]);
    await act(async () => {
      await result.current.send("second");
    });
    // Only one system message, both user turns retained.
    expect(result.current.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(result.current.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "first",
      "second",
    ]);
  });

  it("stamps the current time into the system prompt at send (pinned clock)", async () => {
    const requests: Array<{ messages: { role: string; content: string }[] }> = [];
    nextProvider = {
      complete: vi.fn(async (req: { messages: { role: string; content: string }[] }) => {
        requests.push(req);
        return { kind: "final", content: "ok" } as ProviderResponse;
      }),
    };
    const nowMs = 1700000000000; // 2023-11-14T22:13:20.000Z
    const { result } = renderHook(() =>
      useAssistant({ api: fakeApi(), backend: HOSTED, now: () => nowMs }),
    );

    await act(async () => {
      await result.current.send("top meshes this week?");
    });

    const system = requests[0]!.messages.find((m) => m.role === "system");
    expect(system).toBeTruthy();
    expect(system!.content).toContain(`epoch milliseconds: ${nowMs}`);
    expect(system!.content).toContain(new Date(nowMs).toISOString());
  });

  it("sends the focused core tool set for local and the full catalog for hosted", async () => {
    const capture = (): { provider: LlmProvider; lastToolCount: () => number } => {
      let count = -1;
      return {
        provider: {
          complete: vi.fn(async (req: { tools?: unknown[] }) => {
            count = req.tools?.length ?? -1;
            return { kind: "final", content: "ok" } as ProviderResponse;
          }),
        },
        lastToolCount: () => count,
      };
    };

    const local = capture();
    nextProvider = local.provider;
    const localHook = renderHook(() =>
      useAssistant({ api: fakeApi(), backend: { backend: "local", webllm: { model: "X" } } }),
    );
    await act(async () => {
      await localHook.result.current.send("top meshes?");
    });
    expect(local.lastToolCount()).toBe(coreReadTools.length);
    expect(local.lastToolCount()).toBeLessThan(readTools.length);
    localHook.unmount();

    const hosted = capture();
    nextProvider = hosted.provider;
    const hostedHook = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    await act(async () => {
      await hostedHook.result.current.send("top meshes?");
    });
    expect(hosted.lastToolCount()).toBe(readTools.length);
  });

  it("switches backend and persists the choice", () => {
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    expect(result.current.backend).toEqual(HOSTED);

    act(() => {
      result.current.setBackend({ backend: "local", webllm: { model: "Some-Model" } });
    });

    expect(result.current.backend).toEqual({ backend: "local", webllm: { model: "Some-Model" } });
    expect(localStorage.getItem(BACKEND_CONFIG_STORAGE_KEY)).toContain("Some-Model");
  });

  it("does not persist when persistBackend is false", () => {
    const { result } = renderHook(() =>
      useAssistant({ api: fakeApi(), backend: HOSTED, persistBackend: false }),
    );
    act(() => {
      result.current.setBackend({ backend: "local", webllm: { model: "X" } });
    });
    expect(localStorage.getItem(BACKEND_CONFIG_STORAGE_KEY)).toBeNull();
  });

  it("makes no network calls in local mode (zero egress)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    nextProvider = scriptedProvider([
      { kind: "tool_calls", toolCalls: [{ id: "t1", name: "perf_summary", arguments: {} }] },
      { kind: "final", content: "avg 58 fps" },
    ]);
    const api = fakeApi({ avg: 58 });
    const { result } = renderHook(() =>
      useAssistant({ api, backend: { backend: "local", webllm: { model: "Llama" } } }),
    );

    await act(async () => {
      await result.current.send("how's perf?");
    });

    // The local provider was built, and NOTHING hit the network.
    expect(lastWebllmOptions).toMatchObject({ model: "Llama" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.messages.at(-1)).toMatchObject({ content: "avg 58 fps" });
  });

  it("forwards WebLLM init progress and consent to the provider factory", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "ok" }]);
    const confirmDownload = vi.fn(() => true);
    const { result } = renderHook(() =>
      useAssistant({
        api: fakeApi(),
        backend: { backend: "local", webllm: { model: "M" } },
        confirmDownload,
      }),
    );
    await act(async () => {
      await result.current.send("hi");
    });
    expect(lastWebllmOptions).toMatchObject({ model: "M", confirmDownload });
    expect((lastWebllmOptions as { onInitProgress?: unknown }).onInitProgress).toBeTypeOf(
      "function",
    );
  });

  it("forwards the cache policy and eviction callback to the WebLLM factory (#216)", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "ok" }]);
    const onCacheEvicted = vi.fn();
    const { result } = renderHook(() =>
      useAssistant({
        api: fakeApi(),
        backend: { backend: "local", webllm: { model: "M" } },
        cachePolicy: "keep-all",
        onCacheEvicted,
      }),
    );
    await act(async () => {
      await result.current.send("hi");
    });
    expect(lastWebllmOptions).toMatchObject({ model: "M", cachePolicy: "keep-all" });
    // The factory's callback is wired through to the host's, with the evicted ids.
    const opts = lastWebllmOptions as { onCacheEvicted?: (ids: readonly string[]) => void };
    expect(opts.onCacheEvicted).toBeTypeOf("function");
    opts.onCacheEvicted!(["Hermes-3-Llama-3.1-8B-q4f16_1-MLC"]);
    expect(onCacheEvicted).toHaveBeenCalledWith(["Hermes-3-Llama-3.1-8B-q4f16_1-MLC"]);
  });

  it("leaves the cache policy to the adapter default when not specified", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "ok" }]);
    const { result } = renderHook(() =>
      useAssistant({ api: fakeApi(), backend: { backend: "local", webllm: { model: "M" } } }),
    );
    await act(async () => {
      await result.current.send("hi");
    });
    expect((lastWebllmOptions as { cachePolicy?: unknown }).cachePolicy).toBeUndefined();
  });

  it("clearCachedModels delegates to the WebLLM helper and returns the reclaimed ids (#216)", async () => {
    // Works without a provider having been built (no send yet) — the user may
    // need to reclaim space BEFORE a download can succeed.
    clearCachedModelsMock.mockResolvedValue(["Hermes-3-Llama-3.1-8B-q4f16_1-MLC"]);
    const { result } = renderHook(() => useAssistant({ api: fakeApi() }));

    let cleared: string[] = [];
    await act(async () => {
      cleared = await result.current.clearCachedModels();
    });

    expect(clearCachedModelsMock).toHaveBeenCalledTimes(1);
    expect(cleared).toEqual(["Hermes-3-Llama-3.1-8B-q4f16_1-MLC"]);
    expect(lastWebllmOptions).toBeUndefined();
  });

  it("clearCachedModels propagates a Cache API failure to the caller", async () => {
    const boom = new Error("cache denied");
    clearCachedModelsMock.mockRejectedValue(boom);
    const { result } = renderHook(() => useAssistant({ api: fakeApi() }));
    await expect(result.current.clearCachedModels()).rejects.toBe(boom);
  });

  it("errors when a hosted backend is selected but not configured", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "unused" }]);
    const { result } = renderHook(() =>
      useAssistant({ api: fakeApi(), backend: { backend: "hosted" } }),
    );
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toMatch(/hosted backend/i);
  });

  it("errors when no collector connection is available", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "x" }]);
    const { result } = renderHook(() => useAssistant({ backend: HOSTED }));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toMatch(/collector/i);
  });

  it("surfaces tool errors as done/error activity without throwing", async () => {
    nextProvider = scriptedProvider([
      { kind: "tool_calls", toolCalls: [{ id: "t1", name: "top_meshes", arguments: {} }] },
      { kind: "final", content: "sorry, that failed" },
    ]);
    const api = {
      read: vi.fn(async () => Promise.reject(new Error("boom"))),
    } as unknown as CollectorApi;
    const { result } = renderHook(() => useAssistant({ api, backend: HOSTED }));

    await act(async () => {
      await result.current.send("top meshes?");
    });
    expect(result.current.toolActivity).toEqual([
      { id: "t1", name: "top_meshes", status: "error" },
    ]);
    expect(result.current.status).toBe("idle");
  });

  it("reset clears the conversation", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "hi" }]);
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    await act(async () => {
      await result.current.send("hello");
    });
    expect(result.current.messages.length).toBeGreaterThan(0);
    act(() => result.current.reset());
    expect(result.current.messages).toEqual([]);
    expect(result.current.status).toBe("idle");
  });

  it("surfaces a no_answer notice when a turn ends with empty final content", async () => {
    // Empty final content ⇒ the UI should be able to tell the user the turn
    // produced no text, distinctly from a step-cap give-up.
    nextProvider = scriptedProvider([{ kind: "final", content: "   " }]);
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    await act(async () => {
      await result.current.send("summarize");
    });
    expect(result.current.notice).toEqual({ kind: "no_answer" });
    expect(result.current.status).toBe("idle");
  });

  it("surfaces stopped_on_max_steps with the step count when the model never finalises", async () => {
    // A provider that only ever tool-calls forces the loop to hit its cap; the
    // hook must report that outcome (with N) from runAgent's own signals.
    const alwaysToolCalls: LlmProvider = {
      complete: vi.fn(async () => ({
        kind: "tool_calls",
        toolCalls: [{ id: "t", name: "list_sessions", arguments: {} }],
      })),
    };
    nextProvider = alwaysToolCalls;
    const { result } = renderHook(() =>
      useAssistant({ api: fakeApi(), backend: HOSTED, maxSteps: 3 }),
    );
    await act(async () => {
      await result.current.send("keep going");
    });
    expect(result.current.notice).toEqual({ kind: "stopped_on_max_steps", steps: 3 });
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("leaves notice null when the turn produced text", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "12 sessions." }]);
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    await act(async () => {
      await result.current.send("how many?");
    });
    expect(result.current.notice).toBeNull();
  });

  it("clears notice on reset", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "" }]);
    const { result } = renderHook(() => useAssistant({ api: fakeApi(), backend: HOSTED }));
    await act(async () => {
      await result.current.send("summarize");
    });
    expect(result.current.notice).toEqual({ kind: "no_answer" });
    act(() => result.current.reset());
    expect(result.current.notice).toBeNull();
  });
});
