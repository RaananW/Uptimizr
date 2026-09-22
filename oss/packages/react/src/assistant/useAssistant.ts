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
  filterReadTools,
  renderContextForPrompt,
  runAgent,
  selectReadTools,
  type AgentMessage,
  type CollectorClient,
  type LlmProvider,
  type PromptContextDocument,
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
import { panelSpecV1Schema, type PanelSpecV1Input, type QueryV1 } from "@uptimizr/schema";
import { defaultEncoding, getMetric, suggestChart } from "@uptimizr/metrics";
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

/** One collector read the model made, recorded so an answer can be saved (#310). */
export interface AssistantRead {
  /** The endpoint path, e.g. `api/v1/perf/summary`. */
  path: string;
  /** The query parameters it was called with. */
  params: Record<string, string | number | undefined>;
}

/**
 * Where an assistant-written annotation should land. Everything is optional:
 * the default is a note about the whole project, and a caller that knows the
 * active filters passes the narrower target so the note is pinned where it
 * belongs.
 */
export interface AssistantAnnotationTarget {
  targetKind?: "project" | "scene" | "mesh" | "region" | "metric" | "window";
  targetId?: string;
  /** Epoch ms. */
  since?: number;
  /** Epoch ms. */
  until?: number;
}

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
   * Which read tools to expose to the model, as catalog tool names.
   *
   * The catalog is generated from the metric registry (ADR 0051 §1) and is
   * ~70 tools — every schema is folded into the model's function-calling prompt,
   * which a small local model cannot carry. By default the hook picks for you:
   * the **local** (WebLLM) backend gets agent-core's `coreReadTools` subset and
   * a **hosted** backend gets the full catalog. Pass an explicit list to narrow
   * the surface deliberately — for a focused panel, a token budget, or a model
   * that does better with fewer choices. Names that are not in the catalog are
   * ignored; an empty array falls back to the default selection rather than
   * leaving the model with no tools.
   */
  tools?: readonly string[];
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
   * The answer being streamed for the in-flight turn — the accumulated text so
   * far — or `null` when nothing is streaming. Populated only for **answer**
   * turns: text a tool-calling turn streams (pre-tool commentary) is discarded
   * when that turn ends, so this never shows tool-call chatter as the reply.
   * Cleared, in the same render as `messages` gains the final assistant turn,
   * when the turn completes — so a UI renders the live text and the final
   * answer never both. Providers that do not stream leave it `null`; the answer
   * then lands in `messages` at the end as before.
   */
  partialText: string | null;
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
  /**
   * The project context document this collector served (ADR 0051 §5), or `null`
   * while it is loading, when the collector is too old to serve
   * `GET /api/v1/context`, or when the read failed. Exposed so a UI can show what
   * the assistant knows about the project; the hook injects it into the system
   * prompt either way.
   */
  projectContext: PromptContextDocument | null;
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
  /**
   * Whether the configured key holds the `annotate` capability — i.e. whether
   * {@link annotate} and {@link saveAnalysis} would succeed (#310). `false`
   * until `whoami` answers, and `false` for ever if it cannot.
   */
  canAnnotate: boolean;
  /** The collector reads the last turn made, in order — the saved `query`. */
  lastReads: readonly AssistantRead[];
  /** Store one of the answers as a project annotation. Needs an `annotate` key. */
  annotate: (text: string, target?: AssistantAnnotationTarget) => Promise<void>;
  /** Store the last turn as a saved analysis. Needs an `annotate` key. */
  saveAnalysis: (title: string, conclusion: string) => Promise<void>;
  /**
   * The `queryV1` document behind the last answer, when it came from a `query`
   * tool call — what "Pin as panel" would pin (#315). `null` when the turn
   * answered from a canned endpoint instead, in which case there is no document
   * to re-run and the action is not offered.
   */
  pinnableQuery: QueryV1 | null;
  /**
   * Pin the last answer's query to the project's dashboard as a panel (#315).
   * Needs an `annotate` key. Rejects when the turn had no `query` call, because
   * a panel pinned from a reconstructed question would be a different question.
   */
  pinPanel: (title: string, note?: string) => Promise<void>;
}

/**
 * The path the DSL `query` tool reads through (`@uptimizr/agent-core`'s
 * `queryTool`). Matched rather than imported as a constant because
 * `lastReads` records the path the tool asked for, and this is that string.
 */
const QUERY_READ_PATH = "api/v1/query";

/**
 * The last `queryV1` document the model actually ran, or `null` when the turn
 * used no DSL query.
 *
 * This is what makes "Pin as panel" honest: the panel asks *the question the
 * answer came from*, not a question reconstructed from the prose. A turn that
 * answered from a canned endpoint instead has nothing to pin — the DSL is the
 * only read whose request is a document a panel can re-run — and the action is
 * simply not offered.
 *
 * The **last** query rather than the first: a model that drilled down ran the
 * general query before the specific one, and it is the specific one the answer
 * is about.
 */
function pinnableQueryFrom(reads: readonly AssistantRead[]): QueryV1 | null {
  for (let i = reads.length - 1; i >= 0; i--) {
    const read = reads[i]!;
    if (read.path !== QUERY_READ_PATH) continue;
    const raw = read.params.q;
    if (typeof raw !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as QueryV1;
      }
    } catch {
      // A query the tool built is always valid JSON; anything else is not a
      // query worth pinning, so fall through and keep looking.
    }
  }
  return null;
}

/**
 * Build the spec for "Pin as panel" from a query the model ran.
 *
 * Every choice here is derived, not invented: the chart from the metric's grain
 * (`suggestChart`, which never proposes something the collector would refuse),
 * the encoding from the metric's own label/axis/measure columns, and the range
 * replaced by `"inherit"` so the pinned panel follows the dashboard's filter bar
 * rather than freezing the window the question happened to be asked in.
 *
 * Exported so the same derivation can be tested without a live model.
 */
export function panelSpecForQuery(
  query: QueryV1,
  title: string,
  note?: string,
): PanelSpecV1Input | null {
  const metric = getMetric(query.metric);
  if (metric == null) return null;
  const chart = suggestChart(metric, query);
  // `format` and `explain` are the DSL's response knobs, not part of a spec.
  const { format: _format, explain: _explain, range: _range, ...rest } = query;
  const candidate: PanelSpecV1Input = {
    v: 1,
    title: title.trim().slice(0, 120),
    chart,
    encoding: defaultEncoding(metric, chart),
    span: chart === "world3d" ? 2 : 1,
    query: { ...rest, range: "inherit" },
    ...(note != null && note.trim().length > 0 ? { note: note.trim().slice(0, 500) } : {}),
  };
  // Parse before sending: the pre-fill is derived from registry data, so a spec
  // that does not satisfy its own contract is a bug here, not a bad request to
  // discover at the collector.
  return panelSpecV1Schema.safeParse(candidate).success ? candidate : null;
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
    tools: toolNames,
    now = () => Date.now(),
  } = options;

  // An explicit, non-empty `tools` list wins; otherwise the backend decides
  // (small local models get the core subset, hosted models the full catalog).
  // Keyed on the joined names, not the array identity, so a caller passing an
  // inline literal does not re-derive the selection (and churn `send`) on every
  // render.
  const toolKey = toolNames?.join(",") ?? "";
  const pinnedTools = useMemo(() => {
    if (toolKey.length === 0) return null;
    const picked = filterReadTools(toolKey.split(","));
    return picked.length > 0 ? picked : null;
  }, [toolKey]);

  const ctx = useOptionalUptimizr();
  const api = useMemo<CollectorApi | null>(() => {
    if (apiOption) return apiOption;
    // Identify as the assistant, so its reads land in the collector's agent
    // audit log rather than being skipped as dashboard traffic (ADR 0051 §7).
    if (collectorUrl && apiKey) return new CollectorApi(collectorUrl, apiKey, "assistant");
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

  /**
   * Whether the configured key may write project metadata (#310, ADR 0051 §5).
   *
   * Asked once, from `GET /api/v1/whoami`, so the panel offers "Annotate this"
   * and "Save this analysis" only when they would actually work. A failure — an
   * older collector, an unreachable one — leaves the actions hidden rather than
   * surfacing an error the user cannot act on.
   */
  const [canAnnotate, setCanAnnotate] = useState(false);
  useEffect(() => {
    // `whoami` arrived with #310, and a host app may pass an older or narrower
    // client of its own — so its absence means "cannot annotate", not a crash.
    if (!api || typeof api.whoami !== "function") return;
    let cancelled = false;
    void api
      .whoami()
      .then((who) => {
        if (!cancelled) setCanAnnotate(who.capabilities.includes("annotate"));
      })
      .catch(() => {
        if (!cancelled) setCanAnnotate(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  /**
   * The collector reads the model made during the last turn, in order. This is
   * what "Save this analysis" stores as the analysis' `query`: the question the
   * answer actually came from, rather than a reconstruction of it.
   */
  const [lastReads, setLastReads] = useState<readonly AssistantRead[]>([]);

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [toolActivity, setToolActivity] = useState<AssistantToolActivity[]>([]);
  const [initProgress, setInitProgress] = useState<InitProgress | null>(null);
  const [notice, setNotice] = useState<AssistantNotice | null>(null);
  const [partialText, setPartialText] = useState<string | null>(null);
  // The collector's project context document (ADR 0051 §5, design sketch §E.1):
  // the scene ids, region ids and custom-event names this project really uses.
  // Fetched once per collector connection; the collector caches it server-side,
  // so a remount is cheap.
  const [projectContext, setProjectContext] = useState<PromptContextDocument | null>(null);

  // Refs so `send` reads fresh values without being re-created every render.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const nowRef = useRef(now);
  nowRef.current = now;
  // Read inside `send` without making the context a dependency of it: a document
  // that lands mid-conversation reaches the next turn, and a turn already in
  // flight is not disturbed.
  const projectContextRef = useRef(projectContext);
  projectContextRef.current = projectContext;
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

  // Serialised form of the document currently in state, so an identical refetch
  // does not produce a new object — see the effect below.
  const contextJsonRef = useRef<string | null>(null);

  // Fetch the project context whenever the collector connection changes — a new
  // project, a new key, a new `api`.
  //
  // Two deliberate properties:
  //
  // 1. **Failure is silent.** A collector that predates `GET /api/v1/context`
  //    answers 404. That is not an error the user should see; it just means the
  //    assistant runs with exactly the prompt it has always had. Both paths are
  //    tested.
  // 2. **An identical document does not re-render.** `api` is often built inline
  //    by the caller (`api={new CollectorApi(url, key)}`), so its identity
  //    changes on every render; storing a fresh object here would then feed a
  //    render→effect→setState loop. Comparing the serialised document makes the
  //    second pass a no-op, which settles it — and the collector caches the
  //    document server-side, so the extra read is nearly free.
  useEffect(() => {
    if (!api) {
      contextJsonRef.current = null;
      setProjectContext(null);
      return;
    }
    let cancelled = false;
    const settle = (document: PromptContextDocument | null) => {
      if (cancelled) return;
      const json = JSON.stringify(document) ?? "null";
      if (contextJsonRef.current === json) return;
      contextJsonRef.current = json;
      setProjectContext(document);
    };
    void api
      .read("api/v1/context")
      .then((document) => {
        settle(
          document != null && typeof document === "object"
            ? (document as PromptContextDocument)
            : null,
        );
      })
      .catch(() => settle(null));
    return () => {
      cancelled = true;
    };
  }, [api]);

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
      //
      // The project context block (ADR 0051 §5) is re-rendered on every send for
      // the same reason: a document that arrived after the conversation started
      // still reaches the model, and the block is `""` — leaving the prompt
      // byte-identical to before — when there is no context to inject.
      const contextBlock = renderContextForPrompt(projectContextRef.current, nowRef.current());
      const outgoing: AgentMessage[] = [
        ...refreshSystemPrompt(history, systemPrompt, nowRef.current(), contextBlock),
        userMessage,
      ];
      setMessages(outgoing);
      setToolActivity([]);
      setLastReads([]);
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
        setPartialText(null);

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
            // Remember what was asked, in order, so "Save this analysis" can
            // store the question the answer actually came from (#310).
            setLastReads((prev) => [...prev, { path, params: { ...params } }]);
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
          // A caller-pinned list wins. Otherwise small local models get the
          // focused core tool subset and hosted/frontier models the full
          // catalog. All three are views of the same tool definitions.
          tools: pinnedTools ?? selectReadTools(cfg.backend === "local" ? "core" : "full"),
          maxSteps,
          signal: controller.signal,
          // Live partial answer. A turn's accumulated text is shown as it
          // streams; if that turn ends as a tool call its text was pre-tool
          // commentary, not the answer, so it is dropped (the loop then runs
          // the tool and the next turn streams afresh).
          onStream: (event) => {
            if (event.type === "delta") setPartialText(event.text);
            else if (event.outcome === "tool_calls") setPartialText(null);
          },
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
        // Batched with the `setMessages` above on success, so the streamed
        // bubble and the final assistant turn never render together.
        setPartialText(null);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [api, systemPrompt, maxSteps, pinnedTools, ensureProvider],
  );

  /**
   * "Annotate this": store one of the assistant's answers as a project note
   * (#310). The target defaults to the whole project; a caller that knows what
   * the current view is filtered to passes a narrower one, so the note lands on
   * the scene or mesh it is actually about.
   *
   * The row is attributed to an **agent**, because the text is the model's.
   * The collector decides that from the calling client, not from this payload.
   */
  const annotate = useCallback(
    async (text: string, target?: AssistantAnnotationTarget): Promise<void> => {
      if (!api) throw new Error("No collector connection.");
      await api.createAnnotation({
        targetKind: target?.targetKind ?? "project",
        ...(target?.targetId ? { targetId: target.targetId } : {}),
        ...(target?.since != null ? { since: target.since } : {}),
        ...(target?.until != null ? { until: target.until } : {}),
        text,
      });
    },
    [api],
  );

  /**
   * "Save this analysis": store a titled record of the last turn — the reads
   * the model made as the question, and the answer as the conclusion (#310).
   *
   * `query` is the recorded read list rather than a rewritten summary, so the
   * saved record says what was actually asked. A turn with no reads still
   * saves; the question is then simply empty.
   */
  const saveAnalysis = useCallback(
    async (title: string, conclusion: string): Promise<void> => {
      if (!api) throw new Error("No collector connection.");
      await api.saveAnalysis({
        title,
        query: { reads: lastReads },
        ...(conclusion.trim() ? { conclusion } : {}),
      });
    },
    [api, lastReads],
  );

  /**
   * "Pin as panel": keep the last answer's *question* on the dashboard (#315).
   *
   * The spec is built from the query the model actually ran, with its window
   * replaced by `"inherit"`, so the pinned panel keeps asking the same question
   * of whatever range the dashboard is showing — which is the whole reason an
   * answer is worth pinning rather than screenshotting.
   */
  const pinnableQuery = useMemo(() => pinnableQueryFrom(lastReads), [lastReads]);

  const pinPanel = useCallback(
    async (title: string, note?: string): Promise<void> => {
      if (!api) throw new Error("No collector connection.");
      if (!pinnableQuery) {
        throw new Error("This answer did not come from a query, so there is nothing to pin.");
      }
      const spec = panelSpecForQuery(pinnableQuery, title, note);
      if (!spec) {
        throw new Error(`No panel can be built for the metric "${pinnableQuery.metric}".`);
      }
      await api.pinPanel(spec);
    },
    [api, pinnableQuery],
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
    setPartialText(null);
    setLastReads([]);
    setStatus("idle");
  }, []);

  const isBusy = status === "initializing" || status === "thinking";

  return {
    messages,
    status,
    error,
    toolActivity,
    initProgress,
    partialText,
    notice,
    backend,
    webGpuAvailable,
    models: CURATED_MODELS,
    projectContext,
    isReady: Boolean(api) && Boolean(backend),
    isBusy,
    send,
    setBackend,
    cancel,
    reset,
    clearCachedModels,
    canAnnotate,
    lastReads,
    annotate,
    saveAnalysis,
    pinnableQuery,
    pinPanel,
  };
}
