"use client";

// useAssistant — headless React hook wrapping @uptimizr/agent-core's runAgent
// tool-calling loop (ADR 0050 §2/§3, ADR 0047).
//
// It owns the conversation history, per-turn state, the user-selected LLM
// backend (persisted via agent-core's config helpers), live tool-call progress,
// and WebLLM download/init progress. The loop runs entirely client-side against
// the SAME read-only collector client the panels use (react's `CollectorApi`) —
// no new Uptimizr server component.
//
// The provider FACTORIES are `import()`-ed from agent-core's code-split subpaths
// on first send, and `@mlc-ai/web-llm` stays lazy inside agent-core, so a
// consumer who never opens the assistant pays nothing for the LLM runtime.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  runAgent,
  selectReadTools,
  type AgentMessage,
  type CollectorClient,
  type LlmProvider,
} from "@uptimizr/agent-core";
import {
  CURATED_MODELS,
  isWebGpuAvailable,
  loadBackendConfig,
  saveBackendConfig,
  type AssistantBackendConfig,
  type CuratedModel,
  type InitProgress,
  type WebLlmCachePolicy,
} from "@uptimizr/agent-core/providers";
import { CollectorApi } from "../api";
import { useOptionalUptimizr } from "../provider";
import { DEFAULT_SYSTEM_PROMPT, refreshSystemPrompt } from "./prompt";

/** Coarse per-turn state for the assistant. */
export type AssistantStatus = "idle" | "initializing" | "thinking" | "error";

/**
 * A non-error explanation for a turn that completed without a written answer,
 * derived from `runAgent`'s result (never a heuristic guess):
 * - `no_answer` — the model stopped with an empty final message.
 * - `stopped_on_max_steps` — the loop hit its step cap while the model kept
 *   tool-calling without composing an answer; `steps` is how many it took.
 */
export type AssistantNotice =
  { kind: "no_answer" } | { kind: "stopped_on_max_steps"; steps: number };

/** Default provider-turn cap for the in-browser assistant. Deliberately a touch
 *  higher than agent-core's shared `DEFAULT_MAX_STEPS` (8): small local models
 *  sometimes need an extra turn or two to wrap up. Scoped to this hook so the
 *  shared library default (used by the MCP server and others) is unchanged. */
export const DEFAULT_ASSISTANT_MAX_STEPS = 12;

/** Live status of a single tool call the model made during the current turn. */
export type ToolCallStatus = "running" | "done" | "error";

/** One tool invocation surfaced for progress display. */
export interface AssistantToolActivity {
  /** Provider-assigned call id (when known). */
  id?: string;
  /** Catalog tool name (e.g. `top_meshes`). */
  name: string;
  /** Whether the call is in-flight, finished, or errored. */
  status: ToolCallStatus;
}

/** Options for {@link useAssistant}. */
export interface UseAssistantOptions {
  /** Collector base URL. Falls back to an ambient `<UptimizrProvider>`. */
  collectorUrl?: string;
  /** Project API key. Falls back to an ambient `<UptimizrProvider>`. */
  apiKey?: string;
  /** An already-constructed collector client to reuse instead of URL + key. */
  api?: CollectorApi;
  /**
   * Explicit backend selection. When omitted, the hook loads the persisted
   * choice; if there is none it stays `null` (unselected) so the UI can present
   * an explicit first-run chooser instead of auto-picking a backend. Nothing is
   * loaded or downloaded until the user chooses (ADR 0050 §4, amended).
   */
  backend?: AssistantBackendConfig;
  /** System prompt priming the assistant. Defaults to {@link DEFAULT_SYSTEM_PROMPT}. */
  systemPrompt?: string;
  /** Max provider turns per send (forwarded to `runAgent`). Defaults to
   *  {@link DEFAULT_ASSISTANT_MAX_STEPS}. */
  maxSteps?: number;
  /**
   * Consent gate for the local (WebLLM) backend, invoked once before weights
   * download. Return `false` to abort — nothing is downloaded.
   */
  confirmDownload?: (model: CuratedModel) => boolean | Promise<boolean>;
  /**
   * What the local (WebLLM) backend does with **other** curated models' cached
   * weights when a model loads. Defaults to `"active-only"`: switching models
   * evicts the previous model's ~4 GB cache so caches never stack up in the
   * origin's storage. Pass `"keep-all"` to keep every downloaded model for fast
   * switching at the cost of disk. See `WebLlmCachePolicy` in agent-core.
   */
  cachePolicy?: WebLlmCachePolicy;
  /**
   * Called after a local model load evicted other models' cached weights (under
   * `"active-only"`), with the ids actually removed — possibly empty.
   */
  onCacheEvicted?: (modelIds: readonly string[]) => void;
  /** Persist backend changes to `localStorage`. Defaults to `true`. */
  persistBackend?: boolean;
  /**
   * Clock used to stamp the current time into the system prompt at send time so
   * the model can resolve relative ranges ("today", "this week") into concrete
   * `since`/`until` epoch-ms. Read on **every** send (the single system message
   * is refreshed in place, so a long conversation never goes stale across a day
   * boundary). Defaults to `() => Date.now()`; injectable so tests can pin it.
   */
  now?: () => number;
}

/** The value returned by {@link useAssistant}. */
export interface UseAssistantResult {
  /** Full transcript (system + user + assistant/tool turns) kept for context. */
  messages: AgentMessage[];
  /** Current per-turn state. */
  status: AssistantStatus;
  /** The last error, if the previous turn failed. */
  error: Error | null;
  /** Tool calls made during the current/last turn, with live status. */
  toolActivity: AssistantToolActivity[];
  /** WebLLM download/init progress while a local model loads, else `null`. */
  initProgress: InitProgress | null;
  /**
   * Set when the last completed turn produced no written answer, so the UI can
   * explain the outcome (and suggest a next step) instead of rendering nothing.
   * `null` otherwise. Reset at the start of every send, and on cancel/reset.
   */
  notice: AssistantNotice | null;
  /** The active backend selection, or `null` until one is configured. */
  backend: AssistantBackendConfig | null;
  /** Whether this browser can run the local (WebGPU) backend. */
  webGpuAvailable: boolean;
  /** The curated local models available for selection. */
  models: readonly CuratedModel[];
  /** True when a backend and a collector client are both available. */
  isReady: boolean;
  /** True while a turn is in flight. */
  isBusy: boolean;
  /** Send a user message and run the tool-calling loop. */
  send: (text: string) => Promise<void>;
  /** Switch (and optionally persist) the backend; releases the previous model. */
  setBackend: (config: AssistantBackendConfig) => void;
  /** Cancel the in-flight turn, if any. */
  cancel: () => void;
  /** Clear the conversation (keeps the loaded model). */
  reset: () => void;
  /**
   * Delete every curated local model's cached weights from this browser's Cache
   * Storage (the active one included) and resolve with the ids removed. Reclaims
   * the multi-GB space WebLLM accumulated without touching anything else on the
   * origin. A currently loaded model keeps running from GPU memory; the next
   * page load re-downloads behind consent. Rejects if the Cache API fails, and
   * needs the optional `@mlc-ai/web-llm` peer to be installed.
   */
  clearCachedModels: () => Promise<string[]>;
}

/** True when a provider exposes a GPU-releasing `unload()` (WebLLM does). */
interface Unloadable {
  unload: () => Promise<void>;
}
function isUnloadable(p: LlmProvider): p is LlmProvider & Unloadable {
  return typeof (p as Partial<Unloadable>).unload === "function";
}

/**
 * Build a headless assistant bound to a collector connection and a user-selected
 * LLM backend. See {@link UseAssistantOptions} / {@link UseAssistantResult}.
 */
export function useAssistant(options: UseAssistantOptions = {}): UseAssistantResult {
  const {
    collectorUrl,
    apiKey,
    api: apiOption,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    maxSteps = DEFAULT_ASSISTANT_MAX_STEPS,
    confirmDownload,
    cachePolicy,
    onCacheEvicted,
    persistBackend = true,
    now = () => Date.now(),
  } = options;

  const ctx = useOptionalUptimizr();
  const api = useMemo<CollectorApi | null>(() => {
    if (apiOption) return apiOption;
    if (collectorUrl && apiKey) return new CollectorApi(collectorUrl, apiKey);
    return ctx?.api ?? null;
  }, [apiOption, collectorUrl, apiKey, ctx?.api]);

  const [webGpuAvailable] = useState<boolean>(() => isWebGpuAvailable());
  const [backend, setBackendState] = useState<AssistantBackendConfig | null>(() => {
    // Explicit selection wins; otherwise restore a previously persisted choice.
    // With neither, stay unselected (`null`) so the UI presents a first-run
    // chooser and NOTHING loads until the user picks (ADR 0050 §4, amended).
    if (options.backend) return options.backend;
    return loadBackendConfig();
  });

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [toolActivity, setToolActivity] = useState<AssistantToolActivity[]>([]);
  const [initProgress, setInitProgress] = useState<InitProgress | null>(null);
  const [notice, setNotice] = useState<AssistantNotice | null>(null);

  // Refs so `send` reads fresh values without being re-created every render.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const nowRef = useRef(now);
  nowRef.current = now;
  const onCacheEvictedRef = useRef(onCacheEvicted);
  onCacheEvictedRef.current = onCacheEvicted;
  const providerRef = useRef<{ key: string; provider: LlmProvider } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Release any loaded GPU model when the hook unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      const cached = providerRef.current;
      providerRef.current = null;
      if (cached && isUnloadable(cached.provider)) void cached.provider.unload().catch(() => {});
    };
  }, []);

  const setBackend = useCallback(
    (config: AssistantBackendConfig) => {
      setBackendState(config);
      if (persistBackend) saveBackendConfig(config);
    },
    [persistBackend],
  );

  const buildProvider = useCallback(
    async (cfg: AssistantBackendConfig): Promise<LlmProvider> => {
      if (cfg.backend === "local") {
        const { createWebLlmProvider } = await import("@uptimizr/agent-core/providers/webllm");
        return createWebLlmProvider({
          model: cfg.webllm?.model,
          confirmDownload,
          // Switching models evicts the previous model's cached weights by
          // default (#216); hosts opt into "keep-all" for fast switching.
          cachePolicy,
          onCacheEvicted: (ids) => onCacheEvictedRef.current?.(ids),
          onInitProgress: (p) => {
            setInitProgress(p);
            setStatus(p.progress >= 1 ? "thinking" : "initializing");
          },
        });
      }
      if (!cfg.hosted) {
        throw new Error("Hosted backend selected but not configured (endpoint, key, and model).");
      }
      const { createHostedProvider } = await import("@uptimizr/agent-core/providers/hosted");
      const { api: hostedApi, endpoint, apiKey: key, model } = cfg.hosted;
      return createHostedProvider({ api: hostedApi, endpoint, apiKey: key, model });
    },
    [confirmDownload, cachePolicy],
  );

  // The "Clear cached models" action. Lazily imports the WebLLM subpath (like
  // the provider factory) so a consumer who never touches the local backend
  // still pays nothing for it; the heavy runtime loads only inside the helper.
  const clearCachedModels = useCallback(async (): Promise<string[]> => {
    const { clearCachedModels: clear } = await import("@uptimizr/agent-core/providers/webllm");
    return clear();
  }, []);

  const ensureProvider = useCallback(
    async (cfg: AssistantBackendConfig): Promise<LlmProvider> => {
      const key = JSON.stringify(cfg);
      const cached = providerRef.current;
      if (cached && cached.key === key) return cached.provider;
      if (cached && isUnloadable(cached.provider)) void cached.provider.unload().catch(() => {});
      const provider = await buildProvider(cfg);
      providerRef.current = { key, provider };
      return provider;
    },
    [buildProvider],
  );

  const send = useCallback(
    async (text: string): Promise<void> => {
      const content = text.trim();
      if (!content) return;
      const collector = api;
      const cfg = backendRef.current;
      if (!collector) {
        setError(
          new Error(
            "No collector connection. Pass collectorUrl + apiKey or wrap in <UptimizrProvider>.",
          ),
        );
        setStatus("error");
        return;
      }
      if (!cfg) {
        setError(
          new Error("No assistant backend selected. Choose a local or hosted backend first."),
        );
        setStatus("error");
        return;
      }

      const userMessage: AgentMessage = { role: "user", content };
      const history = messagesRef.current;
      // Re-stamp the current time into the (single) system message on EVERY
      // send — not just the first — so a conversation continued across a
      // calendar boundary still resolves "today" / "this week" against the real
      // current time (#220). The existing system message is updated in place;
      // a second system turn is never appended.
      const outgoing: AgentMessage[] = [
        ...refreshSystemPrompt(history, systemPrompt, nowRef.current()),
        userMessage,
      ];
      setMessages(outgoing);
      setToolActivity([]);
      setError(null);
      setInitProgress(null);
      setNotice(null);
      setStatus("initializing");

      const controller = new AbortController();
      abortRef.current = controller;

      // Mark the earliest still-running tool with a terminal status. runAgent
      // executes tool calls sequentially, so order is preserved.
      const settleNextTool = (final: ToolCallStatus) =>
        setToolActivity((prev) => {
          const idx = prev.findIndex((t) => t.status === "running");
          const current = idx === -1 ? undefined : prev[idx];
          if (!current) return prev;
          const next = prev.slice();
          next[idx] = { ...current, status: final };
          return next;
        });

      try {
        const provider = await ensureProvider(cfg);
        setStatus("thinking");

        const trackingProvider: LlmProvider = {
          async complete(request) {
            const response = await provider.complete(request);
            if (response.kind === "tool_calls") {
              setToolActivity((prev) => [
                ...prev,
                ...response.toolCalls.map((c) => ({
                  id: c.id,
                  name: c.name,
                  status: "running" as ToolCallStatus,
                })),
              ]);
            }
            return response;
          },
        };

        const trackingClient: CollectorClient = {
          async get(path, params) {
            try {
              const data = await collector.read(path, params);
              settleNextTool("done");
              return data;
            } catch (err) {
              settleNextTool("error");
              throw err;
            }
          },
        };

        // DELIBERATE DEVIATION from the issue's "Web Worker where practical"
        // wording (documented in the PR body): the tool-calling loop runs on the
        // main thread, not in a Web Worker. It is non-blocking async I/O — WebLLM
        // already offloads token generation to the GPU, and collector reads are
        // network-bound — so a Worker buys no responsiveness here, while the
        // provider/collector closures we hand `runAgent` are non-cloneable and
        // could not cross the Worker `postMessage` boundary without a larger
        // redesign. Revisit if a future provider does heavy CPU work on-thread.
        const result = await runAgent({
          provider: trackingProvider,
          client: trackingClient,
          messages: outgoing,
          // Small local models get the focused core tool subset; hosted/frontier
          // models get the full catalog. Both are views of the same tool defs.
          tools: selectReadTools(cfg.backend === "local" ? "core" : "full"),
          maxSteps,
          signal: controller.signal,
        });
        setMessages(result.messages);
        // Any tool that never reached client.get (unknown tool / bad args) is settled.
        setToolActivity((prev) =>
          prev.map((t) => (t.status === "running" ? { ...t, status: "done" } : t)),
        );
        // Surface — from runAgent's own signals, not a guess — a turn that ended
        // with no written answer, so the UI never renders nothing. The step cap
        // and the empty-final case are distinct outcomes with different advice.
        if (result.stoppedOnMaxSteps) {
          setNotice({ kind: "stopped_on_max_steps", steps: result.steps });
        } else if (result.content.trim().length === 0) {
          setNotice({ kind: "no_answer" });
        }
        setStatus("idle");
      } catch (err) {
        if (controller.signal.aborted) {
          setStatus("idle");
          return;
        }
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
      } finally {
        setInitProgress(null);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [api, systemPrompt, maxSteps, ensureProvider],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setToolActivity([]);
    setError(null);
    setInitProgress(null);
    setNotice(null);
    setStatus("idle");
  }, []);

  const isBusy = status === "initializing" || status === "thinking";

  return {
    messages,
    status,
    error,
    toolActivity,
    initProgress,
    notice,
    backend,
    webGpuAvailable,
    models: CURATED_MODELS,
    isReady: Boolean(api) && Boolean(backend),
    isBusy,
    send,
    setBackend,
    cancel,
    reset,
    clearCachedModels,
  };
}
