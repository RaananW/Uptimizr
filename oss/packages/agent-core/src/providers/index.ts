/**
 * User-controlled LLM provider adapters for `@uptimizr/agent-core` (ADR 0050 §4).
 *
 * Import from the specific subpaths to keep the local runtime code-split:
 *   - `@uptimizr/agent-core/providers/webllm` — local WebGPU backend
 *   - `@uptimizr/agent-core/providers/hosted` — bring-your-own hosted backend
 *
 * This barrel re-exports both plus the shared backend-selection/persistence
 * helpers for consumers who want everything from one entry point. Importing the
 * barrel pulls in the WebLLM adapter *module* (small), but never the heavy
 * `@mlc-ai/web-llm` runtime — that still loads lazily on first use.
 */

export {
  type AssistantBackendConfig,
  type BackendKind,
  type HostedApi,
  type HostedBackendConfig,
  type KeyValueStorage,
  type WebLlmBackendConfig,
  BACKEND_CONFIG_STORAGE_KEY,
  clearBackendConfig,
  defaultBackendKind,
  isWebGpuAvailable,
  loadBackendConfig,
  saveBackendConfig,
} from "./config.js";

export { type HostedProviderConfig, HostedProviderError, createHostedProvider } from "./hosted.js";

export {
  type CuratedModel,
  type InitProgress,
  type WebLlmEngine,
  type WebLlmProvider,
  type WebLlmProviderOptions,
  type WebLlmRuntime,
  CURATED_MODELS,
  WebGpuUnavailableError,
  WebLlmConsentError,
  createWebLlmProvider,
} from "./webllm.js";
