# @uptimizr/agent-core

## 1.1.1

### Patch Changes

- 9ec59db: Packaged agent docs now cover the `format=full|table|summary` result envelope (and when to prefer
  each), and `@uptimizr/mcp`'s `AGENTS.md`/`llms.txt` additionally document the `uptimizr://scenes`
  resource, the three curated prompts, and the single key capability the server needs (`query`;
  `query:raw` is deliberately not required).

## 1.1.0

### Minor Changes

- afe3002: Generate the read-only tool catalog from the metric registry (ADR 0051 §1). `readTools` is no
  longer a hand-written array of 20 tools: `registryToTools()` derives one tool per `@uptimizr/db`
  metric that the collector serves on a read endpoint — **69** today — with the metric's
  interpretation notes and caveats in its description, an input schema built from the endpoint's
  filters and path parameters, and a new `ReadTool.outputSchema` (`{ rows: Row[] }`) derived from the
  metric's row schema. `@uptimizr/mcp` registers that as the MCP `outputSchema` and now returns
  `structuredContent` alongside the JSON text, so `tools/list` covers the whole read surface —
  dead/rage clicks, jank, per-device and per-scene FPS, coverage, blind spots, scene retention, the
  variant leaderboard and the load→bounce funnel included.

  The 20 tool names that shipped before the registry, and their argument schemas, are unchanged; a
  frozen-fixture test pins them, and the only widening is optional parameters the endpoints already
  accepted. `@uptimizr/agent-core` stays browser-safe: it reads the registry from the
  dependency-free `@uptimizr/metrics` package and never depends on `@uptimizr/db`, proven by a
  browser bundle test and a manifest test.

  New: `registryToTools()` and `filterReadTools(names)` in `@uptimizr/agent-core`, and a `tools`
  option on `@uptimizr/react`'s `useAssistant()` to pin which read tools an assistant may call
  (the per-backend default — the core subset locally, the full catalog hosted — is unchanged).

### Patch Changes

- fa489c1: Drop the `@uptimizr/db` dependency. Both packages read the metric registry, which now ships as the
  dependency-free `@uptimizr/metrics`; neither ever opened a database. `npm i @uptimizr/react` (which
  depends on `@uptimizr/agent-core`) and `npx @uptimizr/mcp` therefore no longer download
  `@duckdb/node-api`, a ~37 MB native binding they could not use. No behaviour, API or tool-catalog
  change — the same 69 tools with the same names, input schemas and output schemas.

  A new `dependencies.test.ts` in each package fails the build if `@uptimizr/db`, or any package with
  a native/optional binary dependency, becomes reachable from `dependencies` / `peerDependencies`
  again; `@uptimizr/agent-core`'s esbuild browser-bundle test continues to prove the same thing from
  the bundler's side.

- 018054b: Generate the collector's self-description from the semantic metric registry (ADR 0051 §1).

  - **`@uptimizr/collector-server`** serves a new, unauthenticated
    `GET /api/v1/openapi.json`: an OpenAPI 3.1 document built from the metric registry and the
    server's own route table, so every path, parameter schema and response schema comes from the
    code that actually serves and validates the request. Semantics OpenAPI cannot express —
    result grain, per-column units, caveats, interpretation, capture channels, row limits,
    dimensions, related metrics and comparison direction — ride along as `x-uptimizr-*` vendor
    extensions. Rate-limited like every other route; it contains no project data.
  - **`@uptimizr/mcp`**'s `uptimizr://capabilities` resource is now built from the registry and
    gains a `metrics` array: the whole registry minus the SQL builder, with each row schema as
    JSON Schema. Existing keys (`schemaVersion`, `readOnly`, `eventTypes`, `params`, `tools`,
    `notes`) are unchanged.
  - The tool/endpoint tables in the packaged `README.md`, `AGENTS.md` and `llms.txt` of
    **`@uptimizr/mcp`** and **`@uptimizr/agent-core`** are now rendered from the registry by
    `scripts/gen-registry-docs.mjs`, with a CI staleness gate (`pnpm gen:docs:check`).

- Updated dependencies [fa489c1]
- Updated dependencies [ee1b7c7]
  - @uptimizr/metrics@0.1.0

## 1.0.1

### Patch Changes

- 3c3ee66: Make the package scripts cross-platform so a fresh Windows checkout can build. `clean` now uses `rimraf` instead of `rm -rf`, and the dashboard's `build`/`build:static`/`prepack`/`start` no longer rely on a POSIX `VAR=value` prefix. No runtime or published-output change.

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

### Minor Changes

- 8194192: Token streaming across the provider seam. `ProviderRequest` gains an optional `onToken(delta)` listener — additive, so `LlmProvider.complete()` still returns `Promise<ProviderResponse>` and every existing provider keeps working unchanged. The hosted adapter now requests a streamed reply whenever a listener is present and parses both the OpenAI-compatible and Anthropic Server-Sent Events formats (partial chunks across reads, `[DONE]`, tool-call deltas) using string membership and linear scans only — no regex over model output — while still returning the complete assembled response; a gateway that ignores `stream` falls back to the JSON body. The WebLLM adapter streams the tools-less answer turn straight from the GPU (tool-calling turns stay non-streaming because WebLLM's Hermes grammar emits a JSON tool-call array there) and honours the abort signal mid-stream. `runAgent` gains `onStream`, re-emitting per-turn `delta` / `turn_end` events (`AgentStreamEvent`) so a UI can render the answer as it is generated and tell an answer turn apart from a tool-call turn; the tool-calling loop is unchanged.
- 6b6a2fe: WebLLM adapter: reclaim previous local-model weights when switching models. Loading a model now evicts the other curated models' cached weights from the browser's Cache Storage first (via WebLLM's `hasModelInCache` / `deleteModelAllInfoInCache`), so switching among the ~4 GB Hermes models no longer stacks caches until the origin's storage quota is exceeded. New `cachePolicy` option on `createWebLlmProvider` (`"active-only"`, the default, or `"keep-all"` to opt out), an `onCacheEvicted(ids)` callback, a `provider.clearCachedModels()` method, and a standalone `clearCachedModels()` helper that deletes every cached curated model and returns the ids reclaimed. Eviction is scoped to the known curated model ids only.

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
