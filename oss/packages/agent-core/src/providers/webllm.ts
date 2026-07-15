/**
 * Local, in-browser LLM adapter backed by WebLLM / WebGPU (ADR 0050 §4/§6).
 *
 * Zero data egress: the model runs entirely on the user's GPU and nothing —
 * neither prompt nor results — leaves the browser. The heavy `@mlc-ai/web-llm`
 * runtime is an **optional** dependency loaded via a lazy `import()` only when
 * the user actually runs the assistant, so `@uptimizr/agent-core` stays small
 * and browser-safe for everyone else. Model weights are downloaded on first use
 * (behind explicit consent) and cached by the runtime in the browser's Cache
 * Storage — never part of any precache.
 */

import type { LlmProvider, ProviderRequest, ProviderResponse } from "../provider.js";
import { isWebGpuAvailable } from "./config.js";
import {
  parseOpenAiCompletion,
  toOpenAiMessages,
  toOpenAiTools,
  type OpenAiCompletion,
  type OpenAiMessage,
  type OpenAiTool,
} from "./openai.js";

/** A curated model the user may install (ADR 0050 §4). */
export interface CuratedModel {
  /** MLC model id passed to the runtime. */
  id: string;
  /** Human-friendly name for the picker. */
  label: string;
  /** Approximate download size, for the consent disclosure. */
  downloadSize: string;
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

/**
 * A small, curated set of **tool-calling-capable** models (ADR 0050 §4). WebLLM
 * only supports function calling on the 7–8B Hermes family (see
 * {@link SUPPORTED_TOOL_CALLING_MODELS}), so there is no small (<3 GB) option —
 * local mode has an inherent ~4 GB download / ~5 GB-VRAM floor. Ordered
 * smallest-first so the default is the least-friction working model. Sizes are
 * approximate (sourced from WebLLM's `prebuiltAppConfig`) and shown to the user
 * before any download.
 */
export const CURATED_MODELS: readonly CuratedModel[] = [
  {
    id: "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
    label: "Hermes 2 Pro (Mistral 7B)",
    downloadSize: "~3.9 GB",
    vram: "~4.0 GB",
    description: "Smallest tool-calling model; the least-friction default.",
  },
  {
    id: "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
    label: "Hermes 2 Pro (Llama 3 8B)",
    downloadSize: "~4.6 GB",
    vram: "~5.0 GB",
    description: "Stronger Llama-3 base; needs a capable GPU.",
  },
  {
    id: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
    label: "Hermes 3 (Llama 3.1 8B)",
    downloadSize: "~4.5 GB",
    vram: "~4.9 GB",
    description: "Highest quality; needs a capable GPU (~5 GB VRAM).",
  },
];

/** Progress report emitted while weights download / the engine initialises. */
export interface InitProgress {
  /** Fraction complete in [0, 1]. */
  progress: number;
  /** Human-readable status text from the runtime. */
  text: string;
}

/** The minimal slice of the `@mlc-ai/web-llm` runtime this adapter uses. */
export interface WebLlmEngine {
  chat: {
    completions: {
      create(request: {
        messages: OpenAiMessage[];
        tools?: OpenAiTool[];
        tool_choice?: "auto";
        stream?: false;
      }): Promise<OpenAiCompletion>;
    };
  };
  unload?(): Promise<void>;
}

/** The subset of the `@mlc-ai/web-llm` module surface this adapter loads. */
export interface WebLlmRuntime {
  CreateMLCEngine(
    model: string,
    engineConfig?: { initProgressCallback?: (report: { progress: number; text: string }) => void },
  ): Promise<WebLlmEngine>;
}

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
   * Injectable runtime loader (for tests / custom hosting). Defaults to a lazy
   * `import("@mlc-ai/web-llm")`.
   */
  loadRuntime?: () => Promise<WebLlmRuntime>;
  /** Injectable WebGPU check (for tests); defaults to real feature detection. */
  hasWebGpu?: () => boolean;
}

/** A WebLLM provider, plus a hook to release GPU resources. */
export interface WebLlmProvider extends LlmProvider {
  /** Release the loaded engine and its GPU memory. Safe to call repeatedly. */
  unload(): Promise<void>;
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

function resolveModel(id: string | undefined): CuratedModel {
  const model = id ? CURATED_MODELS.find((m) => m.id === id) : CURATED_MODELS[0];
  return model ?? { id: id ?? "", label: id ?? "", downloadSize: "?", vram: "?", description: "" };
}

const defaultLoadRuntime = (): Promise<WebLlmRuntime> =>
  import("@mlc-ai/web-llm") as unknown as Promise<WebLlmRuntime>;

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
  let enginePromise: Promise<WebLlmEngine> | undefined;

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
    const runtime = await loadRuntime();
    return runtime.CreateMLCEngine(model.id, {
      initProgressCallback: options.onInitProgress
        ? (report) => options.onInitProgress?.({ progress: report.progress, text: report.text })
        : undefined,
    });
  }

  return {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const engine = await ensureEngine();
      const completion = await engine.chat.completions.create({
        messages: toOpenAiMessages(request.messages),
        tools: toOpenAiTools(request.tools),
        tool_choice: "auto",
        stream: false,
      });
      return parseOpenAiCompletion(completion);
    },
    async unload(): Promise<void> {
      const promise = enginePromise;
      enginePromise = undefined;
      if (!promise) return;
      const engine = await promise.catch(() => undefined);
      await engine?.unload?.();
    },
  };
}
