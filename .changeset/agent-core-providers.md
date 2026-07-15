---
"@uptimizr/agent-core": minor
---

feat(agent-core): add the two user-controlled LLM provider adapters (ADR 0050 §4), exported from
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
