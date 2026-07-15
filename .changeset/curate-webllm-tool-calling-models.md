---
"@uptimizr/agent-core": patch
---

fix(agent-core): curate the local WebLLM models to the tool-calling-capable set and add a preflight
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
