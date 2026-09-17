# Security Policy

We take the security of Uptimizr seriously. This policy covers the open-source collector in this
repository (`oss/`).

## Supported versions

Uptimizr is pre-1.0 and evolving. Security fixes are applied to the latest `main` and released in
the next version. Older pre-release versions are not maintained — please upgrade to the latest
release before reporting an issue.

| Version         | Supported          |
| --------------- | ------------------ |
| `main` / latest | :white_check_mark: |
| older pre-1.0   | :x:                |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's
[security advisories](https://github.com/RaananW/Uptimizr/security/advisories/new). This creates a
private channel with the maintainers. If you prefer email, you can instead reach us at
[security@uptimizr.com](mailto:security@uptimizr.com).

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal proof of concept if possible).
- Affected package(s) / endpoint(s) and version or commit.
- Any suggested remediation.

We aim to acknowledge a report within a few business days and will keep you updated on remediation
progress. Once a fix is released, we are happy to credit you in the advisory unless you prefer to
remain anonymous.

## Scope and design notes

A few intentional design decisions are relevant when assessing reports:

- **Ingestion is intentionally keyless.** `POST /api/v1/collect` accepts unauthenticated input from
  untrusted browsers by design (see [ADR 0003](./docs/adr/0003-privacy-model.md)). It is protected
  by schema validation, bounded payloads, and rate limiting rather than an API key. Reports about
  spoofed/spam events scoped to a known `projectId` are an accepted trade-off, not a vulnerability;
  see the collector's [threat model](./oss/apps/collector-server/README.md#security).
- **Query endpoints require an API key** (`x-api-key`) and are scoped to the resolving project.
- **Keys carry a capability set, not a role.** A key holds any of `ingest`, `query`, `annotate` and
  `query:raw` ([ADR 0051](./docs/adr/0051-ai-first-analytics-layer.md) §7). A request with no key is
  `401`; an authenticated key that lacks the capability a route requires is `403`. `query` covers the
  aggregate read API; `annotate` is the narrow project-**metadata** write path (events are
  append-only and never writable by a key). `GET /api/v1/whoami` reports the calling key's id,
  capabilities and effective budget — never the key itself.
- **Raw per-session data is double-gated.** `GET /api/v1/sessions/:id/events` and the live
  per-session follow `GET /api/v1/live/sessions/:id` require **both**
  `ENABLE_RAW_SESSION_RETENTION` on the collector and the `query:raw` capability on the key; either
  one missing is a `403`. A plain `query` key — the kind handed to an agent or the MCP server —
  cannot reach raw events. The live follow authenticates with a short-lived token because
  `EventSource` cannot send a header; the key's capability set is carried inside that token so the
  same check applies.
- **Per-key rate limits.** A key may carry its own request budget, bucketed on the **key id** rather
  than the client IP, falling back to the collector's `COLLECTOR_RATE_LIMIT_*` defaults. Keyless
  ingestion keeps its separate `COLLECTOR_INGEST_RATE_LIMIT_*` budget.
- **Agent audit log.** Every authenticated request that is not the dashboard's own session is
  recorded in the `agent_audit` table — key id, route **pattern**, bounded and credential-redacted
  params, row count, duration and status, refusals included — and read back at `GET /api/v1/audit`
  with a `query` key. Rows never contain key material. Writes happen after the response is flushed,
  so the log cannot block or fail a request; rows older than `AUDIT_RETENTION_DAYS` (default `30`)
  are swept. The dashboard is skipped by default via `x-uptimizr-client: dashboard`, which is a
  **volume filter, not a security boundary** — anyone holding the key could send that header, and
  already has everything the key allows. `AUDIT_DASHBOARD_REQUESTS=1` records everything.
- **Privacy by default.** No client-side persistent identifiers and no PII by default; the visitor
  id is a server-side daily-rotating hash and raw IPs are never stored.

Issues that fall outside these intentional designs — for example, payload bounds that can be
bypassed, injection, secret/PII leakage in logs or responses, or auth bypass on query routes — are
in scope and we want to hear about them.
