# @uptimizr/agent-core

## 0.3.1

### Patch Changes

- 0af8209: Update runtime dependencies: Fastify 5.12.1 and @fastify/helmet 13.1.1 (collector-server), Next.js 16.3.3 and Babylon.js 9.23.0 (dashboard), and Zod 4.5.4 (schema, agent-core, mcp, replay, collector-server). Dev-only dependency bumps across the remaining packages are not released.

## 0.3.0

### Minor Changes

- dd34af8: Make the local (WebLLM) analytics assistant genuinely useful, not just
  non-crashing, within the in-browser 7–8B Hermes ceiling (ADR 0050).

  - **Current-time grounding.** The assistant now stamps the current time (ISO 8601
    - epoch ms) into the system prompt at send time via a new
      `composeSystemPrompt(base, nowMs)` helper and an injectable `useAssistant({ now })`
      clock (default `Date.now`). Small local models can finally resolve relative
      ranges ("today", "this week", "last 24h") into concrete `since`/`until` args —
      the fix for simple time-scoped questions returning no answer.
  - **Focused core tool set for local.** `@uptimizr/agent-core` adds
    `coreReadTools`, `CORE_READ_TOOL_NAMES`, and `selectReadTools(kind)` — a
    filtered VIEW of the existing `readTools` (schema still lives once). The React
    hook sends the ~7-tool core subset to the **local** backend and the full 20 to
    **hosted** backends, so a 4-bit local model isn't overwhelmed.
  - **Strongest curated default.** `CURATED_MODELS` is reordered strongest-first so
    the default is Hermes 3 (Llama 3.1 8B); all three stay selectable.
  - **Guided example prompts** in `<AssistantPanel>` (single-core-tool starter
    questions) and an honest local-vs-hosted capability note.

## 0.2.2

### Patch Changes

- d12c2f4: Force a final, tools-disabled synthesis turn so the assistant always replies.
  Small local WebLLM (Hermes 7–8B) models often returned an empty `final` answer —
  or kept tool-calling until the step cap — so the loop ended with no reply. When a
  run would otherwise end without a usable answer (an empty final, or `maxSteps`
  reached while still tool-calling), `runAgent` now makes one extra
  `provider.complete()` with tools disabled, forcing the model to compose a
  plain-text answer from the tool results it already gathered (at most one such
  forced turn per run; on/off via `forceFinalAnswer`, default `true`). The hosted
  (OpenAI/Anthropic) and WebLLM adapters now omit `tools`/`tool_choice` entirely
  when no tools are offered so the model answers in prose. Oversized tool results
  are also truncated (plain slice + marker, tunable via `maxToolResultChars`,
  default 8000) to protect small models' context. Still local-only for the local
  backend — no new data egress.
- ae5bcd9: Raise the WebLLM local model's context window to 8192 tokens so the analytics
  assistant's prompt fits. The curated Hermes model records default to a
  4096-token window, which rejected the assistant's system prompt + tool schemas +
  results ("Prompt tokens exceed context window size"). The WebLLM adapter now
  passes `chatOpts.context_window_size` when creating the engine (tunable via
  `createWebLlmProvider({ contextWindowSize })`).
- 8ec1cdb: Explain local-model browser-storage limits instead of a raw "quota exceeded".

  The local WebLLM backend caches each curated model's ~4 GB of weights in the
  browser's Cache Storage; loading or switching among several models accumulates
  multiple copies until the per-origin quota is exceeded, at which point the Cache
  API throws a `QuotaExceededError` DOMException. Previously the assistant rendered
  that bare "Quota exceeded." string, which reads like an LLM API quota even though
  the local backend has zero network egress.

  `@uptimizr/agent-core` now classifies that DOMException (by `instanceof`/`.name`,
  never a regex) and rethrows it as a typed `WebLlmStorageError` with an actionable
  message, from both engine init and generation, while leaving all other errors
  untouched. A best-effort `navigator.storage.estimate()` preflight fails fast
  before a multi-GB download when free space is clearly insufficient (guarded and
  soft — skipped when the API is unavailable or reports ample space). Each
  `CuratedModel` gains a numeric `downloadBytes` field for that comparison, and
  `WebLlmStorageError` / `isQuotaExceededError` are exported.

  `@uptimizr/react`'s `<AssistantPanel>` now renders distinct, accessible guidance
  (free disk space, clear this site's cached data, try the smallest model or a
  hosted backend) for a `WebLlmStorageError`, keeping the generic rendering for all
  other errors.

## 0.2.1

### Patch Changes

- b18c955: Fix the local (WebLLM) assistant backend throwing `CustomSystemPromptError`
  ("When using Hermes-2-Pro function calling via ChatCompletionRequest.tools,
  cannot specify customized system prompt.") when asking a question. WebLLM's
  Hermes function-calling path injects its own system prompt and rejects a
  caller-supplied `system` message while tools are present, so the WebLLM adapter
  now folds the assistant's system instructions into the first user turn when
  tools are sent. Hosted backends (OpenAI/Anthropic) are unchanged.

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
