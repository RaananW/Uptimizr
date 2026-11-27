# ADR 0054: SDK delivery under load: paced flushes, samples dropped first

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Project owner, engineering

## Context

`@uptimizr/sdk-core` queues events and flushes on two triggers: the queue reaching `batchSize`
(default 20) or `flushIntervalMs` elapsing. Flushes are single-flight, and one flush sends
everything queued in batches of up to 1,000 events and about 60 KB (#402).

The batch-size trigger had no pacing. A scene that emits faster than 20 events per round trip
started a new flush as soon as the previous one landed, so the SDK sent one request per round trip.
An animated character streaming `node_transform` samples for each moving part produces about 200
events a second, which meant about ten requests a second on a fast network. The collector's default
ingest budget is 300 requests a minute per client (`COLLECTOR_INGEST_RATE_LIMIT_MAX`), five a second.

Past that budget the collector answers `429` for the rest of its 60-second window. The SDK re-queues
the batch and backs off, the queue reaches `maxQueueSize` (1000), and the oldest events are dropped
whatever they are. Clicks, picks and custom events went with the camera samples around them. In
the playground's three.js first-person scene, a run of locked clicks could lose every click after
the first, and the session showed gaps with nothing stored at all.

The interaction-matrix E2E found this: it keeps the collector's default ingest limit and asserts
that every click of every gesture is stored.

## Decision

1. **The batch-size trigger is paced to one flush a second.** When the queue reaches `batchSize`
   within a second of the last flush that trigger started, the flush is scheduled for the end of
   that second instead of starting at once. A paced flush still sends everything queued, in the same
   bounded batches. The request rate then follows the data volume (about one request per 60 KB),
   not the event count: 200 events a second costs about two requests a second. The interval trigger,
   explicit `client.flush()` calls and the page-exit flush are not paced.
2. **When the queue overflows, samples go first.** The continuous channels of ADR 0012
   (`camera_sample`, `pointer_move`, `frame_perf`, `node_transform`, `resource_sample`) are dropped
   oldest first. Other events are dropped, oldest first, only once no sample is left in the queue.

No option is added. `batchSize` keeps its meaning (the queue size that triggers an early flush) and
its default.

## Consequences

### Positive

- A busy scene stays under the collector's default ingest budget, so no batch is refused.
- An outage, a rate limit or a slow network costs resolution, not facts: a click, pick, custom event
  or session boundary is the last thing dropped.
- Behaviour for ordinary scenes is unchanged. They never reach `batchSize` twice within a second.

### Negative / trade-offs

- In a busy scene, events can wait up to a second longer before they are sent, so live views lag
  by up to a second more.
- During a long outage the queue keeps mostly discrete events, so a replay of that stretch has
  clicks without the camera path that led to them.
- The trim scans the queue when it overflows. The queue is bounded (1000 by default), so this is
  linear in a small number, and it only runs while events are already being lost.

## Alternatives considered

- **Raise the collector's default ingest limit.** It hides the problem for one visitor, but the
  budget is per client IP, so visitors behind one NAT share it. The SDK should not need more
  requests than its data volume justifies.
- **Raise the default `batchSize`.** It lowers the request rate in proportion but keeps it tied to
  the event count, and every scene that emits less would wait longer for its flush.
- **Honour `Retry-After` on a `429`.** It avoids retries that cannot succeed, but the outage, and
  the overflow, remain. It may still be worth adding; it needs the `Transport` contract to report
  the header.
- **Drop the oldest events whatever their type (the previous rule).** Simple, but it treats a click
  like a camera sample, and a click is never repeated by a later event.
