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
- **Privacy by default.** No client-side persistent identifiers and no PII by default; the visitor
  id is a server-side daily-rotating hash and raw IPs are never stored.

Issues that fall outside these intentional designs — for example, payload bounds that can be
bypassed, injection, secret/PII leakage in logs or responses, or auth bypass on query routes — are
in scope and we want to hear about them.
