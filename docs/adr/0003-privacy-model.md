# ADR 0003: Cookieless, GDPR-first privacy model

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

Analytics products handle data that can identify individuals. We want Uptimizr to be
privacy-respecting by default (in the spirit of Plausible/Fathom), minimizing legal and ethical
risk for self-hosters, while still enabling useful analytics
and an opt-in session-replay capability.

## Decision

- **No client-side persistent identifier.** The SDK never sets cookies or stores a durable
  visitor ID in the browser.
- **Server-derived, daily-rotating visitor hash.** The collector computes
  `visitorId = hash(ip + userAgent + dailySalt)`. Because the salt rotates every day, visitors
  cannot be tracked across days, and the raw IP is never stored.
- **No PII collected by default.** The client sends only scene/interaction telemetry. Geo, if
  enabled, is coarse (country-level) and derived server-side.
- **Raw per-session retention is opt-in.** Session replay requires storing the ordered raw event
  stream. This is **off by default** (`ENABLE_RAW_SESSION_RETENTION=false`) and must be
  explicitly enabled per deployment. When off, only aggregate-friendly data is retained.

## Consequences

### Positive

- Cookieless operation typically avoids the need for a cookie-consent banner.
- Self-hosters retain full control of their data; the default posture is defensible under GDPR.
- Clear, documented switch for the privacy/replay trade-off.

### Negative / trade-offs

- Daily salt rotation means cross-day user journeys cannot be reconstructed by default.
- Hash-based visitor identification is approximate (shared IPs/UAs can collide).
- Enabling raw retention shifts compliance responsibility to the deployer; this must be
  surfaced clearly in docs and the dashboard.

## Alternatives considered

- **Cookie-based stable visitor IDs** — richer cross-session analytics, but triggers consent
  requirements and conflicts with the privacy-first goal.
- **No visitor identification at all** — maximally private, but breaks basic uniqueness metrics
  (unique visitors, sessions per visitor).
