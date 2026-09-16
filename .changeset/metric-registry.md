---
"@uptimizr/db": minor
---

Add the semantic metric registry on a new `@uptimizr/db/registry` subpath (ADR 0051 §1): one
`MetricDefinition` per `build*` aggregation — id, description, endpoint, grain, dimensions,
filters, Zod row schema, per-column units and semantics, limits, interpretation, caveats, source
capture channels, related metrics and comparison semantics — plus the closed `DimensionId` /
`FilterId` vocabularies and the `FILTER_TARGETS` map. The registry is pure data with no I/O, so
browser consumers can import it. CI now fails when an aggregation has no entry, when a row schema
does not match real query output, or when an endpoint's querystring keys diverge from its declared
filters. No behaviour change to any endpoint or tool.
