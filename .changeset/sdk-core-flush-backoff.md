---
"@uptimizr/sdk-core": patch
---

Keep a backlog deliverable: `flush` is single-flight, sends the queue in ordered batches of at most 1,000 events and about 60 KB (under the `sendBeacon` quota), and retries a failed batch on an exponential backoff (1 s up to 60 s) instead of on every emitted event. The page-exit flush ignores the backoff.
