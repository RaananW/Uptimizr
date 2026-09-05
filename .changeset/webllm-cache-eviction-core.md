---
"@uptimizr/agent-core": minor
---

WebLLM adapter: reclaim previous local-model weights when switching models. Loading a model now evicts the other curated models' cached weights from the browser's Cache Storage first (via WebLLM's `hasModelInCache` / `deleteModelAllInfoInCache`), so switching among the ~4 GB Hermes models no longer stacks caches until the origin's storage quota is exceeded. New `cachePolicy` option on `createWebLlmProvider` (`"active-only"`, the default, or `"keep-all"` to opt out), an `onCacheEvicted(ids)` callback, a `provider.clearCachedModels()` method, and a standalone `clearCachedModels()` helper that deletes every cached curated model and returns the ids reclaimed. Eviction is scoped to the known curated model ids only.
