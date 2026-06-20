# ADR 0013: Opt-in runtime error capture and its privacy stance

- **Status:** Proposed
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

The tracker should report a _complete_ picture of what happens to the scene, including the
single most common silent failure mode: a JavaScript error or unhandled promise rejection that
breaks the render loop. The browser-events capture design
([`docs/phases/browser-events-capture-design.md`](../phases/browser-events-capture-design.md))
introduces a `runtime_error` event for this.

Unlike every other event, `runtime_error` can carry **personally identifiable information**:
error `message` strings and `stack` frames frequently embed user input, file URLs with query
strings, and other context. That conflicts with the cookieless, no-PII-by-default posture of
[ADR 0003](./0003-privacy-model.md). We need a durable decision on whether and how to capture it
before shipping the feature, rather than leaving the trade-off implicit in code.

## Decision

- **Off by default.** Runtime error capture is gated behind an explicit `captureErrors` config
  flag (default `false`). With it off, no `window.onerror` / `unhandledrejection` listeners are
  attached and no `runtime_error` events are produced.
- **One event type, two sources.** A single `runtime_error` event carries a
  `kind: "error" | "unhandledrejection"` discriminator so both browser error channels share a
  shape without redefining the event.
- **Bounded payload.** The event carries `message` and, when available, `source`, `lineno`,
  `colno`, and `stack`. All free-text fields are length-capped in the Zod schema (`message`
  ≤ 1024, `source` ≤ 1024, `stack` ≤ 4096). The SDK never captures arbitrary local variables or
  the full error object.
- **No automatic redaction; redact via `beforeSend`.** The SDK does not silently strip URLs or
  scrub messages — doing so unreliably would give a false sense of safety. Instead, the existing
  `beforeSend(event) => event | null` hook (already run on every event before it is queued) is
  the supported, documented redaction and drop point. Enabling `captureErrors` makes redaction
  the deployer's explicit responsibility.
- **Storm control.** Consecutive identical errors (same `message` + `stack`) are de-duplicated,
  and at most 50 `runtime_error` events are emitted per session, so an error firing every frame
  cannot flood the queue or storage.
- **Same retention rules.** `runtime_error` is an ordinary event: it flows through the generic
  `payload` column and is only retained raw when `ENABLE_RAW_SESSION_RETENTION=true`, exactly as
  ADR 0003 specifies.

## Consequences

### Positive

- The most common "the scene just died" failure becomes visible on the replay timeline.
- The privacy-first default is preserved: zero error data leaves the page unless a deployer opts
  in, and the redaction seam (`beforeSend`) is explicit and documented.
- Storm control keeps the cost and noise of a looping error bounded.

### Negative / trade-offs

- Deployers who enable `captureErrors` take on responsibility for PII in error text; this must be
  surfaced clearly in the docs and (later) the dashboard.
- De-duplication and the per-session cap can hide the true volume of a repeating error (the count
  is bounded, not reported); acceptable for v1.
- No built-in scrubbing means a careless integrator could capture PII; mitigated by the off-by-
  default stance and documentation.

## Alternatives considered

- **On by default with aggressive auto-redaction** — higher coverage, but auto-redaction is
  unreliable (it cannot know which substrings are sensitive) and contradicts ADR 0003's
  no-PII-by-default principle.
- **Message-only (drop `source`/`stack`)** — lower PII risk, but strips the stack frames that
  make an error actionable, undermining the feature's purpose. The length caps plus `beforeSend`
  give a better balance.
- **A dedicated `scrubError` hook separate from `beforeSend`** — redundant: `beforeSend` already
  sees every event and can inspect `type === "runtime_error"`. A second hook would add surface
  area without new capability.
