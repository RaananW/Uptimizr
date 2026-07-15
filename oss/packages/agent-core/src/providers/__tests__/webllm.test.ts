import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, ProviderRequest } from "../provider.js";
import {
  CURATED_MODELS,
  createWebLlmProvider,
  foldSystemPromptForHermes,
  SUPPORTED_TOOL_CALLING_MODELS,
  UnsupportedToolCallingModelError,
  WebGpuUnavailableError,
  WebLlmConsentError,
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
  create: ReturnType<typeof vi.fn>;
  unload: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => completion as never);
  const unload = vi.fn(async () => undefined);
  const engine: WebLlmEngine = { chat: { completions: { create } }, unload };
  const createEngine = vi.fn(async () => engine);
  const load = vi.fn(async () => ({ CreateMLCEngine: createEngine }) as WebLlmRuntime);
  return { runtime: { CreateMLCEngine: createEngine }, load, create, unload };
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
