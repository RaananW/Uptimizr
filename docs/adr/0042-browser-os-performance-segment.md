# ADR 0041: Browser/OS performance segment derived from the User-Agent at ingestion

- **Status:** Accepted
- **Date:** 2026-06-27
- **Deciders:** Uptimizr maintainers

## Context

[ADR 0028 §2](./0028-performance-analytics-and-percentile-aggregation.md) segments FPS by the
`session_start.device` block we already collect (graphics backend, GPU `renderer`, `isMobile`) and
explicitly **deferred** a coarser browser/OS breakdown to a follow-up, noting it "needs a privacy
note: derived, non-PII, not stored raw." This ADR records that follow-up (issue #11).

The request `User-Agent` is already received at ingestion and consumed to compute the cookieless
visitor hash `hash(ip + ua + dailySalt)` ([ADR 0003](./0003-privacy-model.md)), then discarded. It
carries enough signal for a coarse browser/OS segment ("is my scene slower on Safari / iOS?")
without any SDK or client change.

The tension is privacy: a full User-Agent is high-entropy and, combined with other signals, can
contribute to fingerprinting. We want the analytic value of a browser/OS split without retaining
anything identifying.

## Decision

1. **Derive, don't store.** At ingestion the collector reduces the User-Agent to a coarse
   `{ browser, os }` pair of **low-cardinality family labels** (e.g. `Chrome`/`Safari`/`Firefox`/
   `Edge`/`Opera`/`Other`; `Windows`/`macOS`/`iOS`/`Android`/`Linux`/`ChromeOS`/`Other`). **No
   version numbers, no device model, and the raw User-Agent is never persisted** — only these two
   derived families and the existing visitor hash leave the request.
2. **Server-authoritative enrichment.** The derived `browser`/`os` are merged into the
   `session_start.device` block during enrichment (alongside the visitor id), overriding any
   client-supplied value. They are optional, `passthrough`-friendly fields on `deviceSchema` in
   `@uptimizr/schema`, so the contract stays single-sourced ("events live once").
3. **Query-layer join, no column promotion.** `buildPerfByDevice` reads `browser`/`os` from the
   stored `payload` JSON exactly like the existing `engine`/`isMobile`/`renderer` device fields and
   groups by them. No migration is required; historical rows without the fields coalesce to `''`.
4. **Non-PII classification.** The derived families are coarse, deterministic, and non-identifying,
   consistent with the privacy model (ADR 0003). They are treated like the country-level geo signal:
   derived server-side, never raw, never client-persistent.

## Consequences

### Positive

- Adds a browser/OS performance segment with **zero client or schema-capture change** — it reuses a
  header already on the wire and discarded today.
- The raw User-Agent is never stored, and only coarse families are retained, keeping the
  fingerprinting surface minimal.
- No storage migration: the fields ride in the existing `session_start.device` payload JSON.

### Negative / trade-offs

- The built-in parser is intentionally coarse and heuristic; unusual or spoofed User-Agents fall to
  `Other`, and iPadOS desktop-mode is indistinguishable from macOS.
- Browser/OS labels are best-effort, not a substitute for precise client capability detection.

## Alternatives considered

- **A third-party UA-parsing dependency (e.g. `ua-parser-js`)** — richer/version-aware, but pulls a
  dependency and tempts storing finer-grained, higher-entropy data. Rejected in favor of a tiny
  built-in coarse parser.
- **Promoting `browser`/`os` to dedicated `events` columns** — unnecessary for OSS DuckDB scale and
  would require forward-only migrations for both engines (ADR 0007); the JSON join already used for
  the other device fields is sufficient.
- **Capturing browser/OS on the client** — redundant (the server already sees the UA) and would add
  client-side surface for no benefit.
