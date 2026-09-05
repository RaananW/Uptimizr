---
"@uptimizr/react": minor
---

Assistant (`/assistant` subpath): add a **Clear cached models** action to `<AssistantPanel>` — shown in the local-backend footer and inside the browser-storage-quota error — that deletes every cached local model's weights and reports what was reclaimed. `useAssistant` gains `clearCachedModels()` plus `cachePolicy` (`"active-only"` default | `"keep-all"`) and `onCacheEvicted` options forwarded to the WebLLM adapter, so switching local models evicts the previous model's ~4 GB cache instead of accumulating until the storage quota is hit.
