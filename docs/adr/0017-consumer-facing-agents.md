# ADR 0017: Consumer-facing agent strategy (packaged knowledge + MCP)

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** RaananW

## Context

Uptimizr's contributor-facing agent tooling is mature: `AGENTS.md`, scoped instruction files
under `.github/instructions`, and workflow skills under `.github/skills`. However, all of this
lives under `.github/` — a repository-only, development-time location. None of it travels with the
published npm packages.

This leaves two audiences unserved:

1. **Agents working with the data via our packages.** A developer who installs
   `@uptimizr/babylon` or `@uptimizr/replay` and asks an AI agent "how do I track a custom
   event?" or "how do I query view-direction heatmap data?" gets nothing from the package. The
   knowledge exists in `docs/integration.md` and per-package READMEs, but it is not packaged in
   any agent-consumable form.
2. **Agents that need to query a running collector.** The collector exposes a read query API
   (`docs/integration.md` §Query). There is no programmatic, agent-native way to ask natural
   questions of that data ("what was the most-clicked mesh this week?") under the consumer's own
   trust boundary.

Uptimizr is an analytics product whose value is _querying and understanding 3D data_. Serving the
agents of package _consumers_ is therefore a first-class concern, not an afterthought — and it must
respect the privacy model (ADR 0003) and the self-contained OSS boundary (ADR 0004).

## Decision

Treat the **consumer-facing agent experience as a shipped product surface**, delivered in two ways.

### 1. Ship agent knowledge inside published packages

Every package intended for npm publication includes agent-consumable knowledge in its published
tarball, not only in the repo:

- Add an `AGENTS.md` and an `llms.txt` to each publishable package and include both in the
  package's `files` array so they ship in the tarball.
- `AGENTS.md` describes the package's purpose, public API, and the canonical task recipes
  (e.g. `trackScene`, replay, event-schema usage). `llms.txt` is a concise, link-bearing index
  pointing at the package README and the relevant `docs/` sections.
- Content is **derived from existing docs** (`docs/integration.md`, per-package READMEs) — it is a
  packaged view, not a new source of truth. Do not duplicate event definitions; reference
  `@uptimizr/schema` (ADR — events live once).

### 2. Provide an MCP server for consumers: `@uptimizr/mcp`

Ship an optional Model Context Protocol server that exposes **read-only** tools over a consumer's
**own** collector query API:

- Tools are thin wrappers over the existing query endpoints; the server holds no business logic of
  its own (keep backends thin — ADR 0005). It authenticates with the consumer's `x-api-key` and
  talks only to the collector URL the consumer configures.
- **Read-only by design.** The server exposes no ingestion or mutation tools. No data leaves the
  consumer's infrastructure; the server is a local broker between the consumer's agent and the
  consumer's collector, consistent with replay running on the user's own infrastructure (ADR 0006)
  and the privacy model (ADR 0003).
- Lives in `oss/packages/mcp` as `@uptimizr/mcp`, Apache-2.0, and stays self-contained within the
  OSS workspace (ADR 0004).

### Scope note

This ADR records the _strategy and trust model_. The discrete implementation work (packaging the
files, scaffolding the server, authoring new contributor skills/agents) is tracked as GitHub issues
under the **Agentic experience** milestone, per ADR 0016.

## Consequences

### Positive

- Consumers' agents can understand and operate the packages without scraping the repo.
- Natural-language querying of 3D analytics becomes possible without weakening privacy: read-only,
  on the consumer's own infrastructure, no third-party egress.
- Reinforces existing conventions (events live once, thin backends, self-contained OSS) rather
  than working around them.

### Negative / trade-offs

- More surfaces to keep in sync. Mitigated by deriving packaged knowledge from existing docs and
  by deriving MCP tools mechanically from the documented query API rather than hand-maintaining a
  parallel contract.
- An MCP server is an additional package to version, test, and secure. Mitigated by keeping it a
  thin, read-only wrapper with no independent logic.

## Alternatives considered

- **Docs-only (status quo)** — keep all agent knowledge in `docs/` and `.github/`. Rejected: none
  of it reaches the agents of package consumers, who are the higher-leverage audience for an
  analytics product.
- **A centralized query agent / remote endpoint** — would centralize querying but breaks the
  privacy stance (data egress) and the OSS-first, self-hostable model. It is out of scope here.
- **Read-write MCP server** — exposing ingestion/mutation via MCP. Rejected for the first
  iteration: it widens the attack surface and is unnecessary for the understand-the-data use case.
