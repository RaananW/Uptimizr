---
"@uptimizr/sdk-core": patch
"@uptimizr/three": patch
---

Fix a rejected batch blocking all later delivery. The default transport now treats a definitive 4xx (other than 408/429) as handled instead of re-queueing the same invalid payload at the head of every later flush; the `Transport` contract documents the semantics for custom transports. The aggregator never emits a non-finite or negative `fps` or an infinite `mesh_visibility` bounds box (both fail schema validation and got whole batches rejected), and the three.js connector skips a perf sample when the renderer's frame counter restarts after a context restore instead of emitting a negative fps.
