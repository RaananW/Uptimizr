# ADR 0050: In-browser, user-controlled analytics assistant (client-side agent)

- **Status:** Proposed (amended 2026-07-15 — see [Amendment](#amendment-2026-07-15-explicit-first-run-backend-chooser))
- **Date:** 2026-07-14
- **Deciders:** RaananW
- **Extends:** [ADR 0017](./0017-consumer-facing-agents.md) (consumer-facing agent strategy)

## Context

ADR 0017 gave consumers two agent surfaces: packaged agent knowledge (`AGENTS.md` / `llms.txt`)
and the read-only `@uptimizr/mcp` server. MCP works well for **technical** users who run an MCP
client (Claude Desktop, VS Code, GitHub Copilot CLI, a local coding agent): the server is a Node
process over stdio that queries their **own** collector with an `x-api-key`.

That leaves two gaps:

1. **Non-technical dashboard users.** Someone viewing the OSS dashboard cannot "ask a question" of
   their 3D analytics without installing and configuring an MCP client. The value of the product —
   _understanding_ 3D data — is gated behind developer tooling. A chat box **inside the dashboard**
   ("what were the most-clicked meshes this week, and how's the average FPS?") would serve every
   user of the framework, not just those who wire up MCP.

2. **The backend-less demo (`demo.uptimizr.com`).** By design it has no server, no API key, and no
   central data — the collector query API only exists as an in-browser service-worker shim over
   DuckDB-Wasm (ADR 0020 storage seam preserved). An MCP server (which needs a reachable HTTP
   endpoint + key) therefore **cannot** connect to it. Showing agentic analysis there requires an
   agent that runs _in the browser_ against the same in-browser query layer.

Both gaps point to the same missing surface: a **client-side agent embedded in the UI** that reuses
the existing read query API and, crucially, does not require an Uptimizr-operated backend. It must
respect the privacy model (ADR 0003), the self-contained OSS boundary (ADR 0004), thin backends
(ADR 0005), and the trust stance of ADR 0017 — which deliberately **rejected a centralized/hosted
query agent** because it would mean data egress under Uptimizr's control.

The forces:

- Browsers can now run capable LLMs locally via **WebGPU/WebLLM** (Llama-3.2-1B/3B, Phi-3.5-mini,
  Qwen2.5, Hermes/Llama-3.1-8B; q4f16), but WebGPU coverage is incomplete (older Safari,
  Firefox-on-Android, low-RAM/older mobile) and larger models need 5–6 GB VRAM.
- The dashboard can be shipped as a **static export served by the collector**
  (`DASHBOARD_STATIC=1`), so any agent loop must be able to run **client-side** with no server.
- `@uptimizr/mcp`'s tool catalog (`readTools`) and collector client are **already browser-safe**
  (pure Zod shapes + `buildRequest` + a `fetch`-only client, no Node dependencies), so the same
  "what can an agent ask?" contract can drive both MCP and an in-browser agent without duplication.

## Decision

Add a **client-side, user-controlled analytics assistant** as a first-class OSS surface,
complementary to (not a replacement for) `@uptimizr/mcp`, built on a **single shared tool contract**
consumed by three consumers.

### 1. One tool contract, three consumers

Extract a framework-agnostic package **`@uptimizr/agent-core`** (Apache-2.0, `oss/packages/`) that
owns:

- the **read-only tool catalog** (today's `readTools`: one entry per documented query endpoint),
- a small **LLM provider-adapter interface** (see §4),
- the **tool-calling loop** (LLM ↔ tools ↔ collector), headless and framework-agnostic.

`@uptimizr/mcp` imports the catalog from `@uptimizr/agent-core` instead of defining its own, so the
tool surface is defined **once**. The three consumers become:

- **`@uptimizr/mcp`** — stdio server for external/local agents on the user's machine (unchanged
  model).
- **Dashboard assistant panel** — a thin React `<AssistantPanel>` for every dashboard user.
- **Demo assistant panel** — the same panel embedded in `demo.uptimizr.com`, running against the
  in-browser (service-worker/DuckDB-Wasm) query layer.

All three hit the **same read-only, project-scoped, privacy-preserving** query surface. No consumer
gains ingestion, mutation, or raw-per-session-event access.

### 2. Packaged for reuse — not dashboard-locked

The assistant is **not** an app-private dashboard feature; it ships as reusable, published packages
so downstream builders on the OSS framework can embed it in **their own** workflows, exactly as they
already can with the OSS panels (ADR 0047). Two integration levels:

- **Headless core (`@uptimizr/agent-core`)** — framework-agnostic, no React, no DOM assumptions:
  the tool catalog, the provider-adapter interface, and the tool-calling loop. Usable anywhere a
  consumer already has (or can construct) a collector client — a custom UI, a Node service, a CLI,
  an Electron app, a bot. This is the real "integrate into your workflow" surface.
- **React component** — the `<AssistantPanel>` (plus a headless `useAssistant()` hook) is exported
  from **`@uptimizr/react`**, the portable OSS component catalog (ADR 0047), **not** trapped inside
  `oss/apps/dashboard`. A consumer building their own analytics UI does
  `import { AssistantPanel } from "@uptimizr/react"`, passes their `CollectorApi` (collector URL +
  key) and chosen provider config, and drops it in. The Uptimizr dashboard and the demo are simply
  the first two consumers of that exported component.

Following ADR 0047's precedent, the LLM runtime dependencies (WebLLM, provider SDKs) are **optional
peer dependencies and code-split** behind lazy imports, so consumers of `@uptimizr/react` who never
use the assistant do not pay its bundle or download cost. External agents that prefer MCP keep using
`@uptimizr/mcp` — same contract, different delivery.

### 3. Runs client-side; no new server component

The assistant's tool-calling loop runs in the browser (in a Web Worker where practical) so it works
with the static-export dashboard and the backend-less demo alike. Uptimizr introduces **no**
hosted/proxy agent service (consistent with ADR 0017's rejection of a centralized agent).

### 4. Pluggable, user-controlled LLM backends — off by default

The assistant ships **no model and no key**. It is opt-in and offers user-selected backends behind a
provider-adapter interface:

- **Local (WebLLM / WebGPU):** the user optionally installs a **selected** model from a curated
  list. Weights download **on first use**, gated behind an explicit consent ("downloads ~N GB, runs
  100% locally"), cached in the browser, and never part of any precache (see §6). WebGPU is
  feature-detected; if unavailable the local option is hidden. **Zero data egress.**
- **Bring-your-own hosted provider:** the user supplies an OpenAI-compatible or Anthropic
  endpoint + key stored locally in their browser. The browser calls the provider directly. Only the
  prompt and **aggregated** results (never raw events or PII) leave, to the **user's own** provider.

The choice persists per-user (localStorage). Because both backends are user-controlled and there is
no Uptimizr egress, this stays within the ADR 0017 trust boundary while extending it to a UI
surface.

### 5. Privacy & trust boundary (explicit)

- Local backend: nothing leaves the browser — the strongest privacy posture, ideal default for
  privacy-sensitive self-hosters and the demo.
- Hosted backend: aggregated analytics leave to the user's chosen provider **only after explicit
  opt-in**. The assistant surfaces this clearly. Same data scope as the query API: one project
  (the active key), aggregate-only, no raw events, no PII (ADR 0003).
- The assistant never sees or requests anything the dashboard user could not already see.

### 6. Optional model installation UX (never part of demo prep)

WebLLM weights load through an independent, on-demand fetch cached in the browser's Cache Storage —
**separate** from the demo's "Prepare demo" precache (which only warms the service worker +
DuckDB-Wasm). The WebLLM runtime is `import()`-ed lazily only when the user opens the assistant, and
a model downloads only on the first request. The core dashboard/demo payload is unchanged for users
who never open the assistant.

### 7. Extending `@uptimizr/mcp` (evaluated here)

Because the shared catalog now backs MCP too, this ADR also decides the MCP evolution policy:

- **Reaffirm the boundary.** MCP stays **read-only**: no ingestion, mutation, or raw-per-session
  event tools (ADR 0003 / ADR 0017). This is non-negotiable and applies to `@uptimizr/agent-core`
  as a whole.
- **Allowed extensions** (they map to documented, aggregate, privacy-preserving query endpoints and
  keep the server thin):
  - **New read tools** as query endpoints land — e.g. funnels (ADR 0038), aggregate desire-line
    paths (ADR 0037), rendering-technology breakdown (ADR 0046), AR/VR spatial analytics (ADR
    0048). Adding a tool remains "one entry in the shared catalog."
  - **MCP resources** exposing a machine-readable **capabilities/schema descriptor** (available
    scenes, event types, metric definitions, param semantics) so agents self-discover what they can
    ask instead of guessing.
  - **MCP prompts** — curated prompt templates for common analyses ("weekly scene health",
    "attention hot-spots for scene X") that call the existing tools.
- **Deferred (follow-up, not decided here):** an optional **Streamable HTTP** transport (alongside
  stdio) so remote/browser MCP clients could reach a self-hosted collector. It is only worth doing
  behind proper auth and does not block the in-browser assistant (which needs no MCP transport at
  all). Track separately if demand appears.

### Scope note

This ADR records the **strategy and trust model**. Discrete implementation is tracked as GitHub
issues under the Agentic-experience milestone (per ADR 0016): extract `@uptimizr/agent-core`; add
the provider-adapter interface + WebLLM and BYO-key adapters; export `<AssistantPanel>` +
`useAssistant()` from `@uptimizr/react` (with the LLM deps optional/code-split, ADR 0047) and
consume it from the dashboard and the demo; wire the MCP server to the shared catalog; add MCP
resources/prompts and any new read tools. Every shipped feature updates the public docs site
(`oss/apps/docs`) and, where relevant, `docs/integration.md`.

## Consequences

### Positive

- **Reach:** every dashboard user — not only MCP-savvy developers — can ask natural-language
  questions of their 3D analytics, and the backend-less demo can finally showcase agentic analysis.
- **Consistency + low maintenance:** one tool catalog defines what any agent can ask; MCP, the
  dashboard, and the demo can never drift apart on capabilities.
- **Privacy-preserving and self-contained:** no Uptimizr-operated backend, no default egress; local
  mode has zero egress. Reinforces ADR 0003 / 0004 / 0005 / 0017 rather than working around them.
- **Complementary, not competing:** MCP remains the path for local/external agents (like a coding
  agent) while the in-browser assistant serves the UI — same guarantees, more surfaces.
- **Reusable by downstream builders:** because the component ships in `@uptimizr/react` and the
  engine in `@uptimizr/agent-core` (not inside `oss/apps/dashboard`), anyone building on the OSS
  framework can embed the assistant in their own analytics UI or wire the headless core into their
  own workflow (Node, CLI, bot, custom app) — the same reuse guarantee the OSS panels already have
  (ADR 0047).

### Negative / trade-offs

- **Device coverage:** WebGPU is unavailable on some browsers/devices, so the local backend can't be
  universal; the BYO-key fallback (with its egress trade-off) is required for broad reach.
- **Small-model reliability:** 1–3B in-browser models do tool-calling adequately but not perfectly;
  mitigated by the small, fixed tool surface and forced JSON-schema/structured output. Expectations
  must be set (good summaries, not deep analytics).
- **Browser key handling:** BYO hosted keys live in the user's browser (their machine, their key)
  and require provider CORS; must be documented and opt-in.
- **More surfaces to keep in sync:** three consumers and two provider adapters. Mitigated by the
  shared `@uptimizr/agent-core` contract and by keeping adapters thin.

## Alternatives considered

- **Centralized/hosted query agent** — a server-side or Uptimizr-operated agent. Rejected again
  (per ADR 0017): breaks the privacy stance (egress under our control) and the self-hostable model.
- **Dashboard-only server route** (Next.js/collector `agent/chat`) — needs a running backend and an
  LLM key as a server secret. Rejected as the primary design: it breaks the static-export/self-host
  path and the backend-less demo. (A self-hosted operator may still add one; not required.)
- **MCP-only (status quo)** — keep agents external. Rejected: excludes non-technical users and is
  architecturally impossible for the backend-less demo.
- **Bake in a single fixed model** — simpler UX but poor device coverage and no user choice.
  Rejected in favour of pluggable, user-selected backends.
- **Read-write MCP / in-browser ingestion tools** — rejected; widens attack surface and violates the
  read-only, privacy-preserving contract for no benefit to the understand-the-data use case.
- **Dashboard-app-private component** — implement the panel only inside `oss/apps/dashboard`.
  Rejected: it would trap the feature in the app (the exact problem ADR 0047 fixed for panels),
  denying downstream framework users the ability to embed it. The component must live in the
  published `@uptimizr/react` catalog with the engine in `@uptimizr/agent-core`.

## Amendment (2026-07-15): explicit first-run backend chooser

This amendment **refines the default-selection behaviour** recorded in §4/§5 (which described a
"privacy-preserving default: local when WebGPU is present"). It does **not** change the trust model,
the storage seam, or the read-only/no-egress guarantees — those stand as decided above.

**What changed.** The assistant no longer **auto-selects** a backend on first open. Previously
`useAssistant` pre-selected the local (WebLLM) backend whenever WebGPU was detected, so a first-time
user on a capable machine landed directly on the local-model download gate (a ~4 GB Hermes model)
and never saw the hosted alternative side by side. Instead:

- On first run (no explicit backend passed and no persisted choice), the selection starts
  **unselected** (`null`) and `<AssistantPanel>` presents an **explicit chooser** showing **both**
  backends side by side with their honest tradeoffs — including the hosted data-egress caveat (§5)
  stated on the chooser itself. **Nothing is loaded or downloaded until the user picks.**
- WebGPU detection now **highlights** a suggested option (local is marked _Recommended_ when
  available; shown disabled with a "requires a WebGPU browser" note when not) rather than
  auto-selecting it. `defaultBackendKind()` / `isWebGpuAvailable()` remain available for that hint.
- The two fast paths are unchanged: an explicit `options.backend` still wins, and a previously
  persisted choice is still restored — **returning users are never re-prompted**.

**Why.** Auto-preselecting local turned "open the assistant" into "start a multi-GB download" on the
first click, which surprised users of the demo and dashboard. Presenting both options and letting the
user decide preserves user agency and is **still privacy-preserving** — because nothing loads until a
choice is made, the zero-egress local path is a deliberate, informed choice rather than a silent
default. This keeps the ADR's trust boundary intact while removing the download-friction footgun.
