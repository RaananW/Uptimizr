---
title: Privacy & configuration
description: Uptimizr's privacy model and the configuration that controls retention, CORS, and opt-in capture.
---

Uptimizr is privacy-first by architecture: the responsible default is the easy default.

## The privacy model

- **Cookieless, no client IDs.** No cookies, no `localStorage` identifiers, no fingerprinting.
  Nothing persistent is written to the visitor's device. The `sessionId` is in-memory only.
- **Server-side rotating visitor hash.** Visitors are counted with a hash computed **on the
  server** that rotates **every day**, so individuals can't be tracked across days.
- **Derived, coarse browser/OS — never the raw User-Agent.** The request User-Agent is used only to
  compute the visitor hash and to derive a coarse `{ browser, os }` family pair (e.g. `Safari` /
  `iOS`) for the performance device segment. The raw User-Agent and version are never stored — only
  the two low-cardinality families. Derived, non-PII (ADR 0003 / ADR 0041).
- **No PII by default.** Events carry spatial and performance signals, not personal data. Never put
  PII in `meta`, `track` props, or `user`.
- **Opt-in user descriptor.** `user.id` must be pseudonymous or hashed — never an email, username,
  or raw account id. Omit it to stay fully anonymous (see
  [sdk-core](/docs/connectors/sdk-core/#anonymized-users-opt-in)).

## Retention is opt-in

Raw per-session event retention — the ordered stream that powers **replay** — is **opt-in** on the
collector:

```bash
ENABLE_RAW_SESSION_RETENTION=true
```

With it off, the collector keeps only aggregates; `/api/v1/sessions/:id/events` and
`/api/v1/sessions/:id/narrative` return `403`. The
aggregate endpoints never expose raw events.

Retention is only **half** the gate. Reading a raw per-session stream — the replay timeline
`/api/v1/sessions/:id/events` and the live per-session follow `/api/v1/live/sessions/:id` — also
requires an API key holding the `query:raw`
[capability](/docs/deploy/collector/#api-keys-and-capabilities). A plain `query` key reads
aggregates only, whatever retention is set to, so "who may see raw sessions" is a deliberate,
per-key decision rather than a collector-wide switch.

:::caution[Breaking change]

### What a session narrative shows

`GET /api/v1/sessions/:id/narrative` sits behind the same two gates and returns a **projection**
of the raw stream, not the stream itself. It is an allow-list, not a redactor: it reads only the
fields below, so a future event type cannot widen it by accident.

It **shows** relative timestamps (milliseconds since the session's first event, never a wall-clock
time), scene ids, mesh/object names, interaction kinds and input sources, custom-event and
input-action **names**, frame-rate dips, runtime-error messages (truncated), graphics-diagnostic
category and severity, capability transitions, and the rendering engine / graphics API.

It **never** carries:

- the daily-rotating `visitorId`, or any identifier for a person;
- the page URL, referrer, title, language or any other `pageMeta` field;
- anything from the app-supplied `user` descriptor (`user.id`, traits);
- any position, hit point, ray, UV or screen coordinate;
- any `device` detail beyond the engine — no renderer or vendor string, OS, browser, memory or
  core count;
- custom-event property **values** — only their keys, which are developer-chosen field names;
- a runtime error's `source` (a URL) or `stack`, or a graphics diagnostic's message text.

If your app attaches personal data to a custom-event property or to an error message, that is the
one place it could reach a narrative — error messages are truncated but not filtered, which is the
same trade-off as the raw stream and the dashboard's error panels.

This is a tightening: previously `ENABLE_RAW_SESSION_RETENTION` alone was enough and any `query`
key could read the raw stream. Existing keys keep working for every aggregate endpoint; a key that
drives replay or live-follow must be re-minted with
`uptimizr new-key <projectId> --capabilities query,query:raw`.
:::

## Agent activity is audited

Every authenticated request made with a key that is not the dashboard's own session is written to
an audit trail the project owner can read at `GET /api/v1/audit`: which key (by **id** — never the
key), which endpoint, bounded and redacted parameters, rows returned, duration and status.
Credential-shaped parameters are dropped before the row is written, and rows expire after
`AUDIT_RETENTION_DAYS` (default 30). See
[the collector guide](/docs/deploy/collector/#agent-audit-log).

## Opt-in capture channels

Several capture channels are off by default for privacy and cost, and must be enabled per scene in
the connector (`capture.*` / options):

| Channel          | Event                    | Discloses                                           |
| ---------------- | ------------------------ | --------------------------------------------------- |
| `meshVisibility` | `mesh_visibility`        | Per-object dwell; with `boundingBox`, scene layout. |
| `hoverDwell`     | `hover_dwell`            | Hover hesitation per object.                        |
| `resourceSample` | `resource_sample`        | GPU/memory footprint.                               |
| `gaze`           | `camera_sample.hitPoint` | Where users looked on the geometry.                 |
| `captureErrors`  | `runtime_error`          | Error messages (not auto-redacted).                 |

Enable only what you need.

## CORS & origins

Restrict which browser origins may post and query:

```bash
COLLECTOR_CORS_ORIGINS=https://app.example.com,https://www.example.com
```

An empty dashboard or rejected ingestion is most often a CORS mismatch or a collector URL pointing
at the wrong host.

## Tenant isolation

Every read and write authenticates with a project API key; the project is resolved from the key
server-side. There is no cross-project query — a caller can only ever access its own data.
Do not add a `projectId` param to widen a query; it is ignored.
