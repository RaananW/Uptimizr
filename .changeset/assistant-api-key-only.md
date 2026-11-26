---
"@uptimizr/react": minor
"@uptimizr/agent-core": minor
"@uptimizr/dashboard": minor
---

The assistant now connects your own model provider by API key only (ADR 0053). `<AssistantPanel>` shows one form (an OpenAI-compatible or Anthropic endpoint, an API key and a model) and no longer offers the local WebLLM backend, its model picker, download consent, progress bar, storage-quota error or cache controls; the small in-browser models could not drive the tool catalog reliably. A local choice saved by an earlier release is not restored, so the panel asks for a provider instead of starting a download. The local APIs keep working for existing callers and are marked `@deprecated` until the next major release: `@uptimizr/agent-core/providers/webllm` (`createWebLlmProvider`, `CURATED_MODELS`, `clearCachedModels`, …), `BackendKind` `"local"`, `WebLlmBackendConfig`, `isWebGpuAvailable`, `defaultBackendKind`, and `useAssistant`'s `confirmDownload`, `cachePolicy`, `onCacheEvicted`, `initProgress`, `webGpuAvailable`, `models` and `clearCachedModels`.
