---
"@uptimizr/sdk-core": patch
---

Fix `offload: "worker"` re-queueing a batch the collector rejected with a definitive 4xx: the worker now classifies responses with the same shared rule as the default transport, so only network errors, 5xx, 408 and 429 are retried and a rejected batch no longer rides at the head of every later flush.
