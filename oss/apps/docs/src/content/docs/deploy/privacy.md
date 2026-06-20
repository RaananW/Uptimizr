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

With it off, the collector keeps only aggregates; `/api/v1/sessions/:id/events` returns `403`. The
aggregate endpoints never expose raw events.

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
