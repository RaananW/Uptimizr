# @uptimizr/agent-core

## 0.2.0

### Minor Changes

- dd6e3f8: feat(agent-core): add the two user-controlled LLM provider adapters (ADR 0050 §4), exported from
  code-split subpaths so the core stays lightweight and browser-safe.

  - `@uptimizr/agent-core/providers/webllm` — local, in-browser inference on WebGPU. The
    `@mlc-ai/web-llm` runtime is an optional dependency loaded via a lazy `import()` only on first
    use; a curated model list with size disclosures; an explicit download-consent gate; WebGPU
    feature detection; weights cached by the runtime in Cache Storage (never precached). Zero data
    egress.
  - `@uptimizr/agent-core/providers/hosted` — bring-your-own OpenAI-compatible or Anthropic endpoint
    - key, stored in the browser only; the browser calls the provider directly (only the prompt and
      aggregated results leave, to the user's own provider). Documents the required provider CORS.
  - `@uptimizr/agent-core/providers` — barrel that also exports backend-selection persistence
    (`localStorage`), WebGPU detection, and the privacy-preserving default (local when WebGPU is
    present).

- f3ca500: feat(agent-core): new framework-agnostic, browser-safe package that owns the agent tool surface
  once (ADR 0050 §1).

  It provides the read-only tool catalog (`readTools`, one entry per documented aggregate collector
  query endpoint), the `GET`-only collector client, a headless LLM provider-adapter interface
  (`LlmProvider`), and the headless tool-calling loop (`runAgent`) that drives LLM ↔ tools ↔
  collector. Strictly read-only — no ingestion, mutation, or raw per-session event tools (ADR 0003 /
  ADR 0017). Consumed by `@uptimizr/mcp` and, in future, the dashboard and demo assistants.

- aaf0ea7: feat(agent-core): add read tools for funnels, desire-line paths, rendering technology, and XR analytics

  Extend the shared read-only tool catalog with one entry per existing aggregate query endpoint:
  `funnel` (ADR 0038), `aggregate_paths` (ADR 0037), `rendering_technology` (ADR 0046), and the XR
  comfort/usage tools `xr_rotation` / `xr_sources` / `xr_abandonment` / `xr_locomotion` (ADR 0048).
  The surface stays strictly aggregate and read-only (ADR 0003 / ADR 0017).

### Patch Changes

- 36f78e8: fix(agent-core): curate the local WebLLM models to the tool-calling-capable set and add a preflight
  guard (ADR 0050 §4).

  The curated list previously included models WebLLM **rejects** for `ChatCompletionRequest.tools`
  (e.g. the default `Llama-3.2-1B-Instruct-q4f16_1-MLC`), so users could download gigabytes of weights
  only to hit a runtime "not supported for tools" error on their first question. WebLLM hard-codes
  function calling to the 7–8B Hermes-2-Pro / Hermes-3 family, and the assistant relies on
  tool-calling.

  - `CURATED_MODELS` now lists only tool-calling-capable Hermes q4f16_1 variants, smallest-first — the
    new default is `Hermes-2-Pro-Mistral-7B-q4f16_1-MLC`. VRAM/size disclosures are sourced from
    WebLLM's `prebuiltAppConfig`.
  - New `SUPPORTED_TOOL_CALLING_MODELS` allowlist and `UnsupportedToolCallingModelError`, exported from
    `providers` and `providers/webllm`. `createWebLlmProvider` validates the resolved model **before**
    any download/engine init and throws if it isn't tool-calling-capable — no more wasted downloads.
