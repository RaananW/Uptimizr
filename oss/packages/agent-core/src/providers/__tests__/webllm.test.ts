import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, ProviderRequest } from "../provider.js";
import {
  CURATED_MODELS,
  createWebLlmProvider,
  DEFAULT_LOCAL_CONTEXT_WINDOW,
  foldSystemPromptForHermes,
  isQuotaExceededError,
  SUPPORTED_TOOL_CALLING_MODELS,
  UnsupportedToolCallingModelError,
  WebGpuUnavailableError,
  WebLlmConsentError,
  WebLlmStorageError,
  type WebLlmEngine,
  type WebLlmRuntime,
} from "../webllm.js";

const SYSTEM_PROMPT = "You are the Uptimizr analytics assistant.";

const request: ProviderRequest = {
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "top meshes?" },
  ],
  tools: [{ name: "top_meshes", description: "ranked meshes", parameters: { type: "object" } }],
};

/** A fake engine returning a scripted completion and recording create calls. */
function fakeRuntime(completion: unknown): {
  runtime: WebLlmRuntime;
  load: ReturnType<typeof vi.fn>;
  createEngine: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  unload: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => completion as never);
  const unload = vi.fn(async () => undefined);
  const engine: WebLlmEngine = { chat: { completions: { create } }, unload };
  const createEngine = vi.fn(async () => engine);
  const load = vi.fn(async () => ({ CreateMLCEngine: createEngine }) as WebLlmRuntime);
  return { runtime: { CreateMLCEngine: createEngine }, load, createEngine, create, unload };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebLLM provider", () => {
  it("exposes a curated model list with size disclosures", () => {
    expect(CURATED_MODELS.length).toBeGreaterThan(0);
    for (const model of CURATED_MODELS) {
      expect(model.id).toBeTruthy();
      expect(model.downloadSize).toMatch(/GB/);
      expect(model.vram).toMatch(/GB/);
    }
  });

  it("only curates models WebLLM supports for tool-calling (regression guard for the demo bug)", () => {
    // Every curated model MUST be tool-calling-capable — the assistant relies on
    // function calling, and WebLLM throws at runtime for any other model. This is
    // the guard that would have caught Llama-3.2-1B slipping in as the default.
    for (const model of CURATED_MODELS) {
      expect(SUPPORTED_TOOL_CALLING_MODELS).toContain(model.id);
    }
  });

  it("defaults to a tool-calling-capable model", () => {
    // resolveModel(undefined) picks CURATED_MODELS[0]; it must be supported.
    expect(SUPPORTED_TOOL_CALLING_MODELS).toContain(CURATED_MODELS[0]!.id);
    const provider = createWebLlmProvider({ hasWebGpu: () => true });
    expect(provider).toBeDefined();
  });

  it("defaults to the strongest curated tool-caller (Hermes 3 Llama 3.1 8B)", () => {
    // Curated list is ordered strongest-first so the default (CURATED_MODELS[0],
    // used by resolveModel and any UI models[0] pre-select) is the best answerer
    // on a small 4-bit local model — the fix for the failed simple-question test.
    expect(CURATED_MODELS[0]!.id).toBe("Hermes-3-Llama-3.1-8B-q4f16_1-MLC");
  });

  it("throws UnsupportedToolCallingModelError before any download for an unsupported model", () => {
    const { load } = fakeRuntime({ choices: [{ message: { content: "x" } }] });
    expect(() =>
      createWebLlmProvider({
        model: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
        loadRuntime: load,
        hasWebGpu: () => true,
      }),
    ).toThrow(UnsupportedToolCallingModelError);
    // The guard fires before weights ever download — the runtime is never loaded.
    expect(load).not.toHaveBeenCalled();
  });

  it("loads the runtime lazily — not until the first complete()", async () => {
    const { load } = fakeRuntime({ choices: [{ message: { content: "x" } }] });
    createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });
    expect(load).not.toHaveBeenCalled();
  });

  it("runs a completion locally and parses the answer (no network egress)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { load, create } = fakeRuntime({ choices: [{ message: { content: "The hero mesh." } }] });

    const provider = createWebLlmProvider({
      model: CURATED_MODELS[1]!.id,
      loadRuntime: load,
      hasWebGpu: () => true,
    });
    const res = await provider.complete(request);

    expect(res).toEqual({ kind: "final", content: "The hero mesh." });
    expect(load).toHaveBeenCalledTimes(1);
    // The prompt/tools are shaped and passed to the local engine only. WebLLM's
    // Hermes tool-calling path forbids a `system` role alongside `tools`, so our
    // system instructions are folded into the first user turn.
    const createArg = create.mock.calls[0]![0] as {
      messages: { role: string; content: string }[];
      tools: unknown[];
    };
    expect(createArg.messages.some((m) => m.role === "system")).toBe(false);
    expect(createArg.messages).toEqual([
      { role: "user", content: `${SYSTEM_PROMPT}\n\ntop meshes?` },
    ]);
    expect(createArg.tools).toHaveLength(1);
    // Zero data egress: no fetch to any server.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses tool calls from the local engine", async () => {
    const { load } = fakeRuntime({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "top_meshes", arguments: '{"limit":10}' },
              },
            ],
          },
        },
      ],
    });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });

    const res = await provider.complete(request);

    expect(res).toEqual({
      kind: "tool_calls",
      toolCalls: [{ id: "c1", name: "top_meshes", arguments: { limit: 10 } }],
    });
  });

  it("reuses one engine across calls", async () => {
    const { load } = fakeRuntime({ choices: [{ message: { content: "ok" } }] });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });
    await provider.complete(request);
    await provider.complete(request);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("raises the local context window so the assistant prompt fits (regression guard for the 4096 overflow)", async () => {
    // The demo bug: the model record's default 4096-token window rejected the
    // ~5.9k-token analytics prompt. The adapter must load the engine with a
    // wider window via chatOpts.context_window_size.
    const { load, createEngine } = fakeRuntime({ choices: [{ message: { content: "ok" } }] });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });
    await provider.complete(request);

    expect(createEngine).toHaveBeenCalledTimes(1);
    const chatOpts = createEngine.mock.calls[0]![2] as { context_window_size?: number };
    expect(chatOpts).toEqual({ context_window_size: DEFAULT_LOCAL_CONTEXT_WINDOW });
    expect(DEFAULT_LOCAL_CONTEXT_WINDOW).toBeGreaterThanOrEqual(8192);
  });

  it("forwards a custom contextWindowSize override to the engine", async () => {
    const { load, createEngine } = fakeRuntime({ choices: [{ message: { content: "ok" } }] });
    const provider = createWebLlmProvider({
      loadRuntime: load,
      hasWebGpu: () => true,
      contextWindowSize: 16384,
    });
    await provider.complete(request);

    const chatOpts = createEngine.mock.calls[0]![2] as { context_window_size?: number };
    expect(chatOpts).toEqual({ context_window_size: 16384 });
  });

  it("throws WebGpuUnavailableError and never loads the runtime without WebGPU", async () => {
    const { load } = fakeRuntime({ choices: [{ message: { content: "x" } }] });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => false });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(WebGpuUnavailableError);
    expect(load).not.toHaveBeenCalled();
  });

  it("gates weights download behind consent, and aborts if declined", async () => {
    const { load } = fakeRuntime({ choices: [{ message: { content: "x" } }] });
    const confirmDownload = vi.fn(async () => false);
    const provider = createWebLlmProvider({
      loadRuntime: load,
      hasWebGpu: () => true,
      confirmDownload,
    });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(WebLlmConsentError);
    expect(confirmDownload).toHaveBeenCalledWith(CURATED_MODELS[0]);
    expect(load).not.toHaveBeenCalled();
  });

  it("downloads once consent is granted, disclosing the selected model", async () => {
    const { load } = fakeRuntime({ choices: [{ message: { content: "done" } }] });
    const confirmDownload = vi.fn(async () => true);
    const provider = createWebLlmProvider({
      model: CURATED_MODELS[0]!.id,
      loadRuntime: load,
      hasWebGpu: () => true,
      confirmDownload,
    });

    const res = await provider.complete(request);

    expect(res).toEqual({ kind: "final", content: "done" });
    expect(confirmDownload).toHaveBeenCalledWith(CURATED_MODELS[0]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("forwards init progress to the callback", async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: "ok" } }] }) as never);
    const engine: WebLlmEngine = { chat: { completions: { create } } };
    const createEngine = vi.fn(
      async (
        _model: string,
        cfg?: { initProgressCallback?: (r: { progress: number; text: string }) => void },
      ) => {
        cfg?.initProgressCallback?.({ progress: 0.5, text: "loading" });
        return engine;
      },
    );
    const load = vi.fn(async () => ({ CreateMLCEngine: createEngine }) as WebLlmRuntime);
    const onInitProgress = vi.fn();

    const provider = createWebLlmProvider({
      loadRuntime: load,
      hasWebGpu: () => true,
      onInitProgress,
    });
    await provider.complete(request);

    expect(onInitProgress).toHaveBeenCalledWith({ progress: 0.5, text: "loading" });
  });

  it("never sends a system-role message to the engine across a multi-turn tool exchange", async () => {
    const { load, create } = fakeRuntime({ choices: [{ message: { content: "done" } }] });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });

    // The loop resends the full transcript (incl. the original system message)
    // on every step; folding per-call must keep later tool-result turns free of
    // a `system` role too, while preserving the assistant/tool turns and order.
    const multiTurn: ProviderRequest = {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "top meshes?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "top_meshes", arguments: {} }],
        },
        { role: "tool", toolCallId: "c1", name: "top_meshes", content: '[{"mesh":"hero"}]' },
      ],
      tools: request.tools,
    };

    await provider.complete(multiTurn);

    const sent = create.mock.calls[0]![0] as {
      messages: { role: string; content: string; tool_call_id?: string }[];
    };
    expect(sent.messages.some((m) => m.role === "system")).toBe(false);
    // Order preserved: folded user turn, then the assistant + tool turns intact.
    expect(sent.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(sent.messages[0]).toEqual({ role: "user", content: `${SYSTEM_PROMPT}\n\ntop meshes?` });
    expect(sent.messages[1]!.tool_call_id).toBeUndefined();
    expect(sent.messages[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("sends no function-calling and keeps the system message when no tools are offered", async () => {
    // The loop's forced synthesis pass calls complete() with an empty tool list.
    // WebLLM must then send NO tools/tool_choice (so the model answers in prose)
    // and, without tools, a custom `system` message is allowed — so it is kept
    // rather than folded into the user turn.
    const { load, create } = fakeRuntime({
      choices: [{ message: { content: "You have 42 sessions." } }],
    });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });

    const res = await provider.complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "answer now" },
      ],
      tools: [],
    });

    expect(res).toEqual({ kind: "final", content: "You have 42 sessions." });
    const createArg = create.mock.calls[0]![0] as {
      messages: { role: string; content: string }[];
      tools?: unknown;
      tool_choice?: unknown;
    };
    expect("tools" in createArg).toBe(false);
    expect("tool_choice" in createArg).toBe(false);
    // The system message survives unfolded (allowed without tools).
    expect(createArg.messages).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "answer now" },
    ]);
  });

  it("unloads the engine to release GPU memory", async () => {
    const { load, unload } = fakeRuntime({ choices: [{ message: { content: "ok" } }] });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });
    await provider.complete(request);
    await provider.unload();
    expect(unload).toHaveBeenCalledTimes(1);
  });

  it("unload before any use is a safe no-op", async () => {
    const { load } = fakeRuntime({ choices: [{ message: { content: "ok" } }] });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });
    await expect(provider.unload()).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
});

/** A browser storage-full failure as WebLLM's Cache API surfaces it. */
function quotaException(): DOMException {
  return new DOMException("Quota exceeded.", "QuotaExceededError");
}

/** Stub `navigator.storage.estimate` with a scripted quota/usage (bytes). */
function stubStorageEstimate(estimate: { quota?: number; usage?: number }): void {
  vi.stubGlobal("navigator", {
    storage: { estimate: vi.fn(async () => estimate) },
  });
}

const GIB = 1024 ** 3;

describe("isQuotaExceededError", () => {
  it("classifies a QuotaExceededError DOMException", () => {
    expect(isQuotaExceededError(quotaException())).toBe(true);
  });

  it("classifies a plain object named QuotaExceededError (non-DOM runtimes)", () => {
    expect(isQuotaExceededError({ name: "QuotaExceededError" })).toBe(true);
  });

  it("does not classify other errors", () => {
    expect(isQuotaExceededError(new Error("network down"))).toBe(false);
    expect(isQuotaExceededError(new DOMException("nope", "AbortError"))).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
  });
});

describe("WebLLM provider — browser storage errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a quota DOMException from engine init to WebLlmStorageError", async () => {
    const createEngine = vi.fn(async () => {
      throw quotaException();
    });
    const load = vi.fn(async () => ({ CreateMLCEngine: createEngine }) as WebLlmRuntime);
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(WebLlmStorageError);
  });

  it("maps a quota DOMException from generation to WebLlmStorageError", async () => {
    const create = vi.fn(async () => {
      throw quotaException();
    });
    const engine: WebLlmEngine = { chat: { completions: { create } } };
    const load = vi.fn(async () => ({ CreateMLCEngine: async () => engine }) as WebLlmRuntime);
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(WebLlmStorageError);
  });

  it("propagates a non-quota init error unchanged (does not swallow it)", async () => {
    const boom = new Error("WebGPU device lost");
    const createEngine = vi.fn(async () => {
      throw boom;
    });
    const load = vi.fn(async () => ({ CreateMLCEngine: createEngine }) as WebLlmRuntime);
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });

    await expect(provider.complete(request)).rejects.toBe(boom);
  });

  it("preflight throws WebLlmStorageError before download when storage is clearly too small", async () => {
    // Only ~1 GB free but the default model needs ~3.9 GB — fail fast, no download.
    stubStorageEstimate({ quota: 5 * GIB, usage: 4 * GIB });
    const { load } = fakeRuntime({ choices: [{ message: { content: "x" } }] });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(WebLlmStorageError);
    expect(load).not.toHaveBeenCalled();
  });

  it("preflight is skipped when the estimate shows ample free space", async () => {
    stubStorageEstimate({ quota: 100 * GIB, usage: 1 * GIB });
    const { load } = fakeRuntime({ choices: [{ message: { content: "ok" } }] });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });

    await expect(provider.complete(request)).resolves.toEqual({ kind: "final", content: "ok" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("preflight is skipped when the Storage API is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const { load } = fakeRuntime({ choices: [{ message: { content: "ok" } }] });
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });

    await expect(provider.complete(request)).resolves.toEqual({ kind: "final", content: "ok" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("allows a retry after storage is freed (engine promise is reset on failure)", async () => {
    const createEngine = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw quotaException();
      })
      .mockImplementationOnce(
        async () =>
          ({
            chat: {
              completions: { create: async () => ({ choices: [{ message: { content: "ok" } }] }) },
            },
          }) as WebLlmEngine,
      );
    const load = vi.fn(async () => ({ CreateMLCEngine: createEngine }) as WebLlmRuntime);
    const provider = createWebLlmProvider({ loadRuntime: load, hasWebGpu: () => true });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(WebLlmStorageError);
    await expect(provider.complete(request)).resolves.toEqual({ kind: "final", content: "ok" });
    expect(createEngine).toHaveBeenCalledTimes(2);
  });
});

describe("foldSystemPromptForHermes", () => {
  it("folds a leading system message into the first user turn", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    expect(foldSystemPromptForHermes(messages)).toEqual([{ role: "user", content: "sys\n\nhi" }]);
  });

  it("converts a system-only conversation into a user message", () => {
    const messages: AgentMessage[] = [{ role: "system", content: "sys" }];
    expect(foldSystemPromptForHermes(messages)).toEqual([{ role: "user", content: "sys" }]);
  });

  it("leaves a conversation without a system message unchanged", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(foldSystemPromptForHermes(messages)).toEqual(messages);
  });

  it("preserves assistant/tool turns and their order while folding", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "t", content: "res" },
    ];
    expect(foldSystemPromptForHermes(messages)).toEqual([
      { role: "user", content: "sys\n\nhi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "t", content: "res" },
    ]);
  });

  it("does not mutate the input array", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    foldSystemPromptForHermes(messages);
    expect(messages).toEqual(snapshot);
  });

  it("is idempotent — a folded transcript folds to itself", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const once = foldSystemPromptForHermes(messages);
    expect(foldSystemPromptForHermes(once)).toEqual(once);
  });
});
