/**
 * Local, in-browser LLM adapter backed by WebLLM / WebGPU (ADR 0050 §4/§6).
 *
 * Zero data egress: the model runs entirely on the user's GPU and nothing —
 * neither prompt nor results — leaves the browser. The heavy `@mlc-ai/web-llm`
 * runtime is an **optional** dependency loaded via a lazy `import()` only when
 * the user actually runs the assistant, so `@uptimizr/agent-core` stays small
 * and browser-safe for everyone else. Model weights are downloaded on first use
 * (behind explicit consent) and cached by the runtime in the browser's Cache
 * Storage — never part of any precache. By default only the **active** model
 * stays cached: loading a model evicts the other curated models' weights so
 * switching never stacks multiple ~4 GB caches (see {@link WebLlmCachePolicy}),
 * and {@link clearCachedModels} reclaims everything on demand.
 */

import type { AgentMessage, LlmProvider, ProviderRequest, ProviderResponse } from "../provider.js";
import { isWebGpuAvailable } from "./config.js";
import {
  createOpenAiStreamAssembler,
  parseOpenAiCompletion,
  toOpenAiMessages,
  toOpenAiTools,
  type OpenAiCompletion,
  type OpenAiMessage,
  type OpenAiStreamChunk,
  type OpenAiTool,
} from "./openai.js";
import { abortError } from "./sse.js";

/** A curated model the user may install (ADR 0050 §4). */
export interface CuratedModel {
  /** MLC model id passed to the runtime. */
  id: string;
  /** Human-friendly name for the picker. */
  label: string;
  /** Approximate download size, for the consent disclosure. */
  downloadSize: string;
  /**
   * Approximate download size in **bytes** — the numeric counterpart to
   * {@link downloadSize}. Used by the storage preflight to compare against
   * `navigator.storage.estimate()` without parsing the human string.
   */
  downloadBytes: number;
  /** Approximate GPU memory (VRAM) required. */
  vram: string;
  /** One-line description of the trade-off. */
  description: string;
}

/**
 * The complete set of model ids WebLLM supports for `ChatCompletionRequest.tools`
 * (function calling). WebLLM hard-codes tool-calling to the Hermes-2-Pro /
 * Hermes-3 family — its tool-call system prompt and output parser are
 * Hermes-specific — so passing any other model with `tools` throws at runtime.
 * The assistant relies on tool-calling, so every {@link CuratedModel} MUST be in
 * this allowlist. Keep this list in sync with WebLLM's own supported set (these
 * are the exact ids WebLLM names in its runtime error). Plain string membership
 * only — never build a regex from a model id.
 */
export const SUPPORTED_TOOL_CALLING_MODELS: readonly string[] = [
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
];

/** Bytes per binary gigabyte (GiB) — the unit browsers report cache usage in. */
const BYTES_PER_GIB = 1024 ** 3;

/** Extra free space (beyond the raw download) the storage preflight insists on. */
const STORAGE_HEADROOM_BYTES = Math.round(0.5 * BYTES_PER_GIB);

/**
 * A small, curated set of **tool-calling-capable** models (ADR 0050 §4). WebLLM
 * only supports function calling on the 7–8B Hermes family (see
 * {@link SUPPORTED_TOOL_CALLING_MODELS}), so there is no small (<3 GB) option —
 * local mode has an inherent ~4 GB download / ~5 GB-VRAM floor. Ordered
 * **strongest-first** so the default ({@link resolveModel} / a UI `models[0]`
 * pre-select) is the best tool-caller, which most reliably answers even simple
 * single-step questions on a 4-bit local model. Sizes are approximate (sourced
 * from WebLLM's `prebuiltAppConfig`) and shown to the user before any download.
 */
export const CURATED_MODELS: readonly CuratedModel[] = [
  {
    id: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
    label: "Hermes 3 (Llama 3.1 8B)",
    downloadSize: "~4.5 GB",
    downloadBytes: Math.round(4.5 * BYTES_PER_GIB),
    vram: "~4.9 GB",
    description: "Highest quality; the default. Needs a capable GPU (~5 GB VRAM).",
  },
  {
    id: "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
    label: "Hermes 2 Pro (Llama 3 8B)",
    downloadSize: "~4.6 GB",
    downloadBytes: Math.round(4.6 * BYTES_PER_GIB),
    vram: "~5.0 GB",
    description: "Stronger Llama-3 base; needs a capable GPU.",
  },
  {
    id: "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
    label: "Hermes 2 Pro (Mistral 7B)",
    downloadSize: "~3.9 GB",
    downloadBytes: Math.round(3.9 * BYTES_PER_GIB),
    vram: "~4.0 GB",
    description: "Smallest tool-calling model; the least-VRAM fallback.",
  },
];

/**
 * Context window (in tokens) the adapter requests when initialising a local
 * model, overriding WebLLM's model-record default (which is 4096 for the curated
 * Hermes records). The analytics assistant's prompt — its system instructions
 * plus the tool JSON schemas and any tool results — runs well past 4096 tokens
 * (~5.9k observed on the demo), so the model errored with
 * "Prompt tokens exceed context window size". Every curated Hermes 7–8B model
 * natively supports 8k+ context, so 8192 comfortably fits the prompt with
 * headroom while staying within the models' real limits. Passed through as
 * `chatOpts.context_window_size` (see {@link WebLlmChatOptions}); the
 * mutually-exclusive `sliding_window_size` keeps its model-record default (-1).
 */
export const DEFAULT_LOCAL_CONTEXT_WINDOW = 8192;

/**
 * The subset of `@mlc-ai/web-llm`'s `ChatOptions` (`Partial<ChatConfig>`) this
 * adapter sets to override a model record's defaults. Verified against
 * `@mlc-ai/web-llm` v0.2.84: `CreateMLCEngine(modelId, engineConfig?, chatOpts?)`
 * and `ChatConfig` exposes `context_window_size` / `sliding_window_size`. We only
 * ever set `context_window_size`; the field is declared optional so the object is
 * a valid partial override.
 */
export interface WebLlmChatOptions {
  /** Token context window to load the model with. */
  context_window_size?: number;
  /** Sliding-window size; mutually exclusive with `context_window_size` in mlc. */
  sliding_window_size?: number;
}

/** Progress report emitted while weights download / the engine initialises. */
export interface InitProgress {
  /** Fraction complete in [0, 1]. */
  progress: number;
  /** Human-readable status text from the runtime. */
  text: string;
}

/** The chat-completion request shape this adapter sends to the runtime. */
export interface WebLlmChatRequest {
  messages: OpenAiMessage[];
  tools?: OpenAiTool[];
  tool_choice?: "auto";
  stream?: boolean;
}

/** The minimal slice of the `@mlc-ai/web-llm` runtime this adapter uses. */
export interface WebLlmEngine {
  chat: {
    completions: {
      /**
       * OpenAI-compatible completion. With `stream: true` the runtime resolves
       * to an async iterable of `chat.completion.chunk`s; otherwise to one
       * completion. Typed as a union (not overloads) so a fake engine in tests
       * can return either.
       */
      create(
        request: WebLlmChatRequest,
      ): Promise<OpenAiCompletion | AsyncIterable<OpenAiStreamChunk>>;
    };
  };
  /** Stop the in-flight streamed generation (WebLLM's `interruptGenerate`). */
  interruptGenerate?(): void;
  unload?(): Promise<void>;
}

/** The subset of the `@mlc-ai/web-llm` module surface this adapter loads. */
export interface WebLlmRuntime {
  CreateMLCEngine(
    model: string,
    engineConfig?: { initProgressCallback?: (report: { progress: number; text: string }) => void },
    chatOpts?: WebLlmChatOptions,
  ): Promise<WebLlmEngine>;
  /**
   * Whether a model's weights are present in the browser's Cache Storage.
   * Optional so an older/minimal runtime degrades to "no eviction" gracefully.
   */
  hasModelInCache?(modelId: string): Promise<boolean>;
  /**
   * Delete everything WebLLM cached for a model (weights, wasm, chat config).
   * Optional for the same reason as {@link WebLlmRuntime.hasModelInCache}.
   */
  deleteModelAllInfoInCache?(modelId: string): Promise<void>;
}

/**
 * How the adapter treats **other** curated models' cached weights when it loads
 * one (issue #216):
 *
 * - `"active-only"` (default) — when a model loads, every other known local
 *   model's cached weights are evicted first, so switching among the curated
 *   models never stacks multiple ~4 GB caches in the origin's storage (the root
 *   cause of the storage-quota errors). The user pays a re-download to switch back.
 * - `"keep-all"` — never evict on load; every downloaded model stays cached for
 *   fast switching at the cost of disk. Users can still reclaim space explicitly
 *   via {@link clearCachedModels} / `WebLlmProvider.clearCachedModels()`.
 *
 * Eviction is scoped to the ids in {@link SUPPORTED_TOOL_CALLING_MODELS} — the
 * only models this adapter can ever have loaded — and never touches any other
 * cache on the origin.
 */
export type WebLlmCachePolicy = "active-only" | "keep-all";

/** The default {@link WebLlmCachePolicy}: keep only the active model cached. */
export const DEFAULT_CACHE_POLICY: WebLlmCachePolicy = "active-only";

/** Options for {@link createWebLlmProvider}. */
export interface WebLlmProviderOptions {
  /** Curated model id to load. Defaults to the first curated model. */
  model?: string;
  /**
   * Consent gate invoked once, before weights download begins. Return `false`
   * (or reject) to abort — the adapter throws {@link WebLlmConsentError} and no
   * data is downloaded. Use this to show the "~N GB, runs 100% locally" prompt.
   */
  confirmDownload?: (model: CuratedModel) => boolean | Promise<boolean>;
  /** Called with download/initialise progress. */
  onInitProgress?: (progress: InitProgress) => void;
  /**
   * Token context window to load the local model with, overriding the model
   * record's default. Defaults to {@link DEFAULT_LOCAL_CONTEXT_WINDOW} (8192),
   * which fits the assistant's prompt on every curated Hermes model. Raise it
   * only up to a value the selected model actually supports.
   */
  contextWindowSize?: number;
  /**
   * What to do with **other** curated models' cached weights when this model
   * loads. Defaults to {@link DEFAULT_CACHE_POLICY} (`"active-only"`): evict them
   * so a single active model never stacks caches. See {@link WebLlmCachePolicy}.
   */
  cachePolicy?: WebLlmCachePolicy;
  /**
   * Called after the load-time eviction under `"active-only"` with the ids that
   * were actually removed from Cache Storage (possibly empty). Useful to tell the
   * user which previously downloaded model was reclaimed.
   */
  onCacheEvicted?: (modelIds: readonly string[]) => void;
  /**
   * Injectable runtime loader (for tests / custom hosting). Defaults to a lazy
   * `import("@mlc-ai/web-llm")`.
   */
  loadRuntime?: () => Promise<WebLlmRuntime>;
  /** Injectable WebGPU check (for tests); defaults to real feature detection. */
  hasWebGpu?: () => boolean;
}

/** A WebLLM provider, plus hooks to release GPU resources and cached weights. */
export interface WebLlmProvider extends LlmProvider {
  /** Release the loaded engine and its GPU memory. Safe to call repeatedly. */
  unload(): Promise<void>;
  /**
   * Delete **every** known local model's cached weights from the browser's
   * Cache Storage — including the active model's — and return the ids that were
   * actually removed. Reclaims the space that "clear site data" would, without
   * touching anything else on the origin. An already-loaded engine keeps running
   * from GPU memory; the next page load re-downloads (behind consent).
   */
  clearCachedModels(): Promise<string[]>;
}

/** Options for the standalone {@link clearCachedModels} helper. */
export interface ClearCachedModelsOptions {
  /**
   * Injectable runtime loader (for tests / custom hosting). Defaults to a lazy
   * `import("@mlc-ai/web-llm")`.
   */
  loadRuntime?: () => Promise<WebLlmRuntime>;
  /** Model ids to keep (skipped even when cached). Defaults to none. */
  keep?: readonly string[];
}

/** Thrown when the local backend is used on a browser without WebGPU. */
export class WebGpuUnavailableError extends Error {
  constructor() {
    super("WebGPU is not available in this browser; the local model cannot run.");
    this.name = "WebGpuUnavailableError";
  }
}

/** Thrown when the user declines the model-download consent prompt. */
export class WebLlmConsentError extends Error {
  constructor() {
    super("Model download was not confirmed by the user.");
    this.name = "WebLlmConsentError";
  }
}

/**
 * Thrown when the requested model is not one WebLLM supports for tool-calling
 * (see {@link SUPPORTED_TOOL_CALLING_MODELS}). Raised as a preflight check —
 * *before* any weights download or engine init — so the user never downloads
 * gigabytes only to hit WebLLM's runtime `tools` error. The message mirrors
 * WebLLM's own so consumers can surface a consistent explanation.
 */
export class UnsupportedToolCallingModelError extends Error {
  constructor(modelId: string) {
    super(
      `${modelId} is not supported for tool-calling. The assistant requires function calling; ` +
        `WebLLM supports it only on these models: ${SUPPORTED_TOOL_CALLING_MODELS.join(", ")}.`,
    );
    this.name = "UnsupportedToolCallingModelError";
  }
}

/**
 * Thrown when the browser is out of storage for the local model. WebLLM caches
 * each curated model's ~4 GB of weights in the origin's **Cache Storage**;
 * loading or switching among several curated models accumulates multiple copies
 * until the per-origin storage quota is exceeded, at which point the Cache API
 * `put` throws a `QuotaExceededError` DOMException. That is a **browser storage**
 * limit — never an LLM API quota (the local backend has zero network egress), so
 * the raw "Quota exceeded." message is misleading. This typed error carries an
 * actionable remedy instead. See {@link isQuotaExceededError} for classification
 * (by `instanceof`/`.name` only — never a regex over the message, per ADR/CodeQL).
 */
export class WebLlmStorageError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "Your browser is out of storage for the local model (each model needs ~4 GB of cache). " +
          "Clear the cached models, free up disk space, or switch to a hosted backend, then retry.",
    );
    this.name = "WebLlmStorageError";
  }
}

/**
 * Classify a thrown value as a browser storage-quota error **without** parsing
 * its message (no regex — avoids CodeQL ReDoS on attacker-influenced text). A
 * quota failure surfaces as a `DOMException` named `"QuotaExceededError"`; some
 * non-DOM runtimes throw a plain object with the same `name`, so accept that too.
 */
export function isQuotaExceededError(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "QuotaExceededError";
  }
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "QuotaExceededError"
  );
}

/**
 * Map a caught value to a {@link WebLlmStorageError} when — and only when — it is
 * a browser storage-quota failure; otherwise return it unchanged so genuine
 * WebGPU/network/model errors propagate. Never swallows non-quota errors.
 */
function mapStorageError(err: unknown): unknown {
  return isQuotaExceededError(err) ? new WebLlmStorageError() : err;
}

/** The slice of `navigator.storage` used by the preflight (feature-detected). */
interface StorageEstimator {
  estimate(): Promise<{ quota?: number; usage?: number }>;
}

function getStorageEstimator(): StorageEstimator | undefined {
  const storage =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { storage?: unknown }).storage
      : undefined;
  if (storage && typeof (storage as { estimate?: unknown }).estimate === "function") {
    return storage as StorageEstimator;
  }
  return undefined;
}

/**
 * Best-effort, **soft** preflight: fail fast with a {@link WebLlmStorageError}
 * *before* a multi-GB download when free storage is unambiguously too small,
 * which otherwise produces a corrupt half-download (silent "no response").
 *
 * `navigator.storage.estimate()` is imprecise and often reports a large origin
 * budget even when the disk is nearly full, so this only throws when the numbers
 * clearly show insufficient headroom, and is skipped entirely when the API is
 * unavailable — the real quota error is still caught and classified at write time.
 */
async function preflightStorage(model: CuratedModel): Promise<void> {
  const estimator = getStorageEstimator();
  if (!estimator) return;
  let estimate: { quota?: number; usage?: number };
  try {
    estimate = await estimator.estimate();
  } catch {
    // An estimate failure is non-fatal — proceed and let the write-time
    // classifier handle a real quota error.
    return;
  }
  const quota = estimate.quota;
  const usage = estimate.usage ?? 0;
  if (typeof quota !== "number" || quota <= 0) return;
  const free = quota - usage;
  // Require the download plus a small headroom margin; only throw when the
  // estimate is confident there is not enough room.
  const needed = model.downloadBytes + STORAGE_HEADROOM_BYTES;
  if (free < needed) {
    const neededGib = (model.downloadBytes / BYTES_PER_GIB).toFixed(1);
    throw new WebLlmStorageError(
      `Not enough browser storage for ${model.label}: it needs about ${neededGib} GB of free ` +
        "cache space. Free up disk space or clear this site's cached data, then retry — " +
        "or switch to a hosted backend.",
    );
  }
}

/** A separator between the folded system instructions and the user's question. */
const SYSTEM_FOLD_SEPARATOR = "\n\n";

/**
 * Fold any `system` message into the first `user` turn for WebLLM's Hermes
 * function-calling path.
 *
 * WebLLM injects its OWN tool-calling system prompt for the Hermes-2-Pro /
 * Hermes-3 family and **forbids** a caller-supplied `system` message whenever
 * `tools` are present — it throws `CustomSystemPromptError`
 * ("…cannot specify customized system prompt.") at runtime (verified against
 * `@mlc-ai/web-llm` v0.2.79: the check is gated on both `request.tools` being
 * present and the model id starting with `Hermes-2-Pro-`/`Hermes-3-`). Our
 * assistant always sends `[{ role: "system", … }, userMessage]` plus tools, so
 * the local backend hit that error.
 *
 * This pure helper removes every `system` message and prepends their content —
 * in order, joined by a blank line — to the first `user` message, so the model
 * still receives our analytics instructions, just not as a `system` role. If
 * there is no `user` message yet, the folded system text becomes a `user`
 * message. All other turns (assistant / tool) keep their relative order.
 *
 * Plain string/array operations only (no regex — avoids CodeQL ReDoS), and the
 * input array is never mutated. It is idempotent per call because it always
 * derives from the messages passed in, so re-folding the full transcript on
 * every loop step never reintroduces a `system` role.
 */
export function foldSystemPromptForHermes(messages: readonly AgentMessage[]): AgentMessage[] {
  const systemContents: string[] = [];
  const rest: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemContents.push(message.content);
    } else {
      rest.push(message);
    }
  }
  if (systemContents.length === 0) return [...messages];

  const systemText = systemContents.join(SYSTEM_FOLD_SEPARATOR);
  const firstUserIndex = rest.findIndex((message) => message.role === "user");
  if (firstUserIndex === -1) {
    // No user turn yet: carry the instructions in as a user message so the
    // model still receives them without a forbidden `system` role.
    return [{ role: "user", content: systemText }, ...rest];
  }

  return rest.map((message, index) => {
    if (index !== firstUserIndex) return message;
    return {
      role: "user",
      content: systemText + SYSTEM_FOLD_SEPARATOR + message.content,
    };
  });
}

/** Duck-type an async iterable (a streamed `create()` result). */
function isAsyncIterable(value: unknown): value is AsyncIterable<OpenAiStreamChunk> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

/**
 * Drain a streamed completion: forward each text delta to `onToken` as it is
 * generated and assemble the chunks into one complete completion. Honors an
 * abort signal by interrupting the runtime's generation (releasing the GPU
 * pipeline) and rejecting with an `AbortError`, like a cancelled `fetch`.
 */
async function collectStreamedChunks(
  engine: WebLlmEngine,
  chunks: AsyncIterable<OpenAiStreamChunk>,
  onToken: (delta: string) => void,
  signal: AbortSignal | undefined,
): Promise<OpenAiCompletion> {
  const assembler = createOpenAiStreamAssembler();
  for await (const chunk of chunks) {
    if (signal?.aborted) {
      engine.interruptGenerate?.();
      throw abortError();
    }
    const delta = assembler.push(chunk);
    if (delta) onToken(delta);
  }
  return assembler.finish();
}

function resolveModel(id: string | undefined): CuratedModel {
  const model = id ? CURATED_MODELS.find((m) => m.id === id) : CURATED_MODELS[0];
  return (
    model ?? {
      id: id ?? "",
      label: id ?? "",
      downloadSize: "?",
      downloadBytes: 0,
      vram: "?",
      description: "",
    }
  );
}

const defaultLoadRuntime = (): Promise<WebLlmRuntime> =>
  import("@mlc-ai/web-llm") as unknown as Promise<WebLlmRuntime>;

/**
 * Evict the cached weights of every known local model except those in `keep`,
 * using an already-loaded runtime. Returns the ids that were actually removed.
 *
 * Scoped strictly to {@link SUPPORTED_TOOL_CALLING_MODELS} (plain `includes` on
 * the id — never a regex) so nothing else cached on the origin is ever touched.
 * A runtime without the cache APIs is a no-op. Errors propagate to the caller,
 * which decides whether eviction is best-effort (load-time) or must surface
 * (an explicit user action).
 */
async function evictCachedModels(
  runtime: WebLlmRuntime,
  keep: readonly string[],
): Promise<string[]> {
  const hasModelInCache = runtime.hasModelInCache;
  const deleteModelAllInfoInCache = runtime.deleteModelAllInfoInCache;
  if (typeof hasModelInCache !== "function" || typeof deleteModelAllInfoInCache !== "function") {
    return [];
  }
  const evicted: string[] = [];
  for (const id of SUPPORTED_TOOL_CALLING_MODELS) {
    if (keep.includes(id)) continue;
    if (!(await hasModelInCache.call(runtime, id))) continue;
    await deleteModelAllInfoInCache.call(runtime, id);
    evicted.push(id);
  }
  return evicted;
}

/**
 * Delete every known local model's cached weights from the browser's Cache
 * Storage and return the ids that were removed. The user-facing "Clear cached
 * models" action: it reclaims the multi-GB space WebLLM accumulated (the same
 * space the browser's "clear site data" would) without needing a provider
 * instance and without touching any other cache on the origin. Errors from the
 * runtime/Cache API propagate so the UI can report them.
 *
 * Loads the runtime lazily via `import("@mlc-ai/web-llm")` (or the injected
 * `loadRuntime`); a runtime without the cache APIs resolves to `[]`.
 */
export async function clearCachedModels(options: ClearCachedModelsOptions = {}): Promise<string[]> {
  const runtime = await (options.loadRuntime ?? defaultLoadRuntime)();
  return evictCachedModels(runtime, options.keep ?? []);
}

/**
 * Create a local WebLLM provider. The runtime and model weights load lazily on
 * the first {@link LlmProvider.complete} call — construction is cheap and has no
 * side effects, so it is safe to build eagerly and feature-detect via
 * {@link isWebGpuAvailable} before offering the local option.
 */
export function createWebLlmProvider(options: WebLlmProviderOptions = {}): WebLlmProvider {
  const model = resolveModel(options.model);
  // Preflight (defense-in-depth): fail fast if the model can't do tool-calling,
  // so we never download weights only to hit WebLLM's runtime `tools` error.
  if (!SUPPORTED_TOOL_CALLING_MODELS.includes(model.id)) {
    throw new UnsupportedToolCallingModelError(model.id);
  }
  const loadRuntime = options.loadRuntime ?? defaultLoadRuntime;
  const hasWebGpu = options.hasWebGpu ?? (() => isWebGpuAvailable());
  const contextWindowSize = options.contextWindowSize ?? DEFAULT_LOCAL_CONTEXT_WINDOW;
  const cachePolicy = options.cachePolicy ?? DEFAULT_CACHE_POLICY;
  let enginePromise: Promise<WebLlmEngine> | undefined;

  /**
   * Under `"active-only"`, reclaim every OTHER known model's cached weights
   * before this model's download so switching models never stacks caches
   * (#216). Best-effort: a Cache API failure must never block the load — the
   * write-time quota classifier still catches a genuinely full origin.
   */
  async function evictOtherModels(runtime: WebLlmRuntime): Promise<void> {
    if (cachePolicy !== "active-only") return;
    let evicted: string[];
    try {
      evicted = await evictCachedModels(runtime, [model.id]);
    } catch {
      return;
    }
    options.onCacheEvicted?.(evicted);
  }

  function ensureEngine(): Promise<WebLlmEngine> {
    if (!enginePromise) {
      enginePromise = initEngine().catch((err) => {
        // Reset so a later attempt (e.g. after granting consent) can retry.
        enginePromise = undefined;
        throw err;
      });
    }
    return enginePromise;
  }

  async function initEngine(): Promise<WebLlmEngine> {
    if (!hasWebGpu()) throw new WebGpuUnavailableError();
    if (options.confirmDownload) {
      const ok = await options.confirmDownload(model);
      if (!ok) throw new WebLlmConsentError();
    }
    // The runtime module is a small import — the multi-GB weights only download
    // inside CreateMLCEngine below. Load it first so the cache eviction can run
    // BEFORE the storage preflight measures free space.
    const runtime = await loadRuntime();
    await evictOtherModels(runtime);
    // Fail fast if free browser storage is unambiguously too small for the
    // multi-GB download, avoiding a corrupt half-download (silent no-response).
    await preflightStorage(model);
    // Override the model record's default context window (4096 for the curated
    // Hermes records) so the assistant's system prompt + tool schemas + results
    // fit. `sliding_window_size` is left at its model-record default (-1); the
    // two are mutually exclusive in mlc.
    try {
      return await runtime.CreateMLCEngine(
        model.id,
        {
          initProgressCallback: options.onInitProgress
            ? (report) => options.onInitProgress?.({ progress: report.progress, text: report.text })
            : undefined,
        },
        { context_window_size: contextWindowSize },
      );
    } catch (err) {
      // Weights are written to Cache Storage during init; a full origin quota
      // surfaces as a QuotaExceededError. Reclassify only that — everything else
      // (WebGPU, network, model errors) propagates unchanged.
      throw mapStorageError(err);
    }
  }

  return {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const engine = await ensureEngine();
      const hasTools = request.tools.length > 0;
      // WebLLM's Hermes tool-calling path injects its own system prompt and
      // rejects a caller-supplied `system` message when `tools` are present, so
      // fold our system instructions into the first user turn for that case.
      // Without tools (e.g. the loop's forced synthesis pass) a custom `system`
      // message is allowed, so we keep it and send no function-calling at all.
      const messages = hasTools ? foldSystemPromptForHermes(request.messages) : request.messages;
      // Stream only the tools-less turn. With `tools` present WebLLM's Hermes
      // function-calling path forces a JSON-grammar tool-call array as the whole
      // output (non-streaming returns `content: null`), so its deltas are
      // tool-call JSON — never user-visible text — and streaming them would only
      // leak that JSON into a UI. The answer text always arrives on the
      // tools-disabled turn (the loop's forced synthesis pass), which streams.
      const onToken = request.onToken;
      const stream = Boolean(onToken) && !hasTools;
      try {
        const result = await engine.chat.completions.create({
          messages: toOpenAiMessages(messages),
          ...(hasTools
            ? { tools: toOpenAiTools(request.tools), tool_choice: "auto" as const }
            : {}),
          stream,
        });
        if (stream && onToken && isAsyncIterable(result)) {
          return parseOpenAiCompletion(
            await collectStreamedChunks(engine, result, onToken, request.signal),
          );
        }
        return parseOpenAiCompletion(result as OpenAiCompletion);
      } catch (err) {
        // Generation can also write to Cache Storage (e.g. lazily fetched shards),
        // so a quota failure here maps to the same actionable storage error.
        throw mapStorageError(err);
      }
    },
    async unload(): Promise<void> {
      const promise = enginePromise;
      enginePromise = undefined;
      if (!promise) return;
      const engine = await promise.catch(() => undefined);
      await engine?.unload?.();
    },
    async clearCachedModels(): Promise<string[]> {
      // Explicit user action: clears EVERY known model (the active one too) and
      // lets runtime/Cache API errors propagate so the UI can report them.
      return clearCachedModels({ loadRuntime });
    },
  };
}
