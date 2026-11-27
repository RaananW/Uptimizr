---
"@uptimizr/sdk-core": patch
---

Keep every click when a busy scene meets the collector's ingest rate limit (ADR 0054). The
batch-size trigger now starts at most one flush a second, and each flush still sends everything
queued in bounded batches, so a scene that emits hundreds of events a second (an animated
character's `node_transform` samples) sends about one request per 60 KB instead of one per round
trip, and stays under the collector's default ingest budget. When the queue does overflow, the
oldest samples (`camera_sample`, `pointer_move`, `frame_perf`, `node_transform`,
`resource_sample`) are dropped first, and clicks, picks and custom events only once no sample is
left.
