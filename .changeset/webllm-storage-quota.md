---
"@uptimizr/agent-core": patch
"@uptimizr/react": patch
---

Explain local-model browser-storage limits instead of a raw "quota exceeded".

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
