---
title: In-browser assistant (LLM)
description: Ask natural-language questions of your 3D analytics with a client-side agent that uses your own model provider and API key. No Uptimizr backend; aggregates only, sent only to your provider.
lastUpdated: 2026-11-26
---

The in-browser assistant lets anyone ask natural-language questions of their 3D analytics
("what were the most-clicked meshes this week, and how's the average FPS?") **without** installing an
MCP client. The agent loop runs entirely in the browser against the same read-only
[query API](/docs/api/query/) a human dashboard user sees — one project, aggregate-only, no raw
events, no PII.

It ships **no model and no key**. You connect **your own model provider** with your own API key, and
the browser calls that provider directly. Uptimizr operates no backend and no proxy for it
([ADR 0050](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0050-in-browser-analytics-assistant.md),
[ADR 0053](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0053-assistant-api-key-providers-only.md)).

The provider adapter lives in
[`@uptimizr/agent-core`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/agent-core/README.md),
imported from a code-split subpath so consumers who never use the assistant pay nothing for it:

```ts
import { createHostedProvider } from "@uptimizr/agent-core/providers/hosted";
```

## Connecting a provider

You supply an **OpenAI-compatible** or **Anthropic** endpoint, an API key and a model. The key and
endpoint are stored **only in your browser** (`localStorage`) and the browser calls **your own**
provider directly. Using the assistant sends your question and the **aggregated** tool results the
loop produces to that provider, and nowhere else (never raw events or PII, ADR 0050 §5). The panel
says so on the form, before anything is sent.

```ts
import { createHostedProvider } from "@uptimizr/agent-core/providers/hosted";

// OpenAI-compatible
const openai = createHostedProvider({
  api: "openai",
  endpoint: "https://api.openai.com/v1", // or a gateway / self-hosted OpenAI-compatible URL
  apiKey: "sk-…",
  model: "gpt-4o-mini",
});

// Anthropic
const anthropic = createHostedProvider({
  api: "anthropic",
  endpoint: "https://api.anthropic.com/v1",
  apiKey: "sk-ant-…",
  model: "claude-3-5-haiku-latest",
});
```

The first time you open `<AssistantPanel>` it shows that form, and **nothing is sent until you
connect a provider**. Your choice persists, so returning users go straight to the chat, and
**Change provider** reopens the form (pre-filled) at any time.

### Required provider CORS

Because the request originates in the browser, the provider must allow cross-origin calls:

- **Anthropic** — the adapter sends the `anthropic-dangerous-direct-browser-access: true` header,
  which enables Anthropic's browser CORS path. No proxy needed.
- **OpenAI-compatible** — `api.openai.com` does **not** send permissive CORS headers, so calling it
  directly from a browser is blocked. Use a provider/gateway that returns
  `Access-Control-Allow-Origin` for your dashboard's origin (many self-hosted servers and LLM
  gateways do), or run the assistant against such an endpoint.

## Getting good answers

- **Current-time grounding.** The system prompt is stamped with the current time (ISO 8601 + epoch
  ms) at send time, so relative ranges like _"today"_, _"this week"_, or _"the last 24 hours"_
  resolve to concrete `since`/`until` epoch-millisecond arguments instead of being dropped or
  guessed. The stamp is refreshed on **every** send — the conversation's single system message is
  updated in place, never duplicated — so a long-lived conversation that crosses midnight keeps
  resolving _"today"_ against the real current day. The clock is injectable via
  `useAssistant({ now })` for deterministic tests, and the pure `refreshSystemPrompt()` helper
  (`messages, basePrompt, nowMs`) is exported for custom loops.
- **The full tool catalog.** The assistant hands your model all **77** read tools, generated from
  the metric registry
  ([ADR 0051](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0051-ai-first-analytics-layer.md)).
  `@uptimizr/agent-core` also exports a focused **core subset** (`selectReadTools("core")` /
  `coreReadTools`) — `list_sessions`, `list_scenes`, `top_meshes`, `perf_summary`, `event_counts`,
  `timeseries` and `camera_heatmap` — for a small model that chooses better from fewer tools.
- **Pin your own tool list.** Pass `useAssistant({ tools: ["perf_summary", "jank_rate"] })` to
  override the default with a deliberate subset — useful for a focused panel, a tight token budget,
  or a model that chooses better from fewer options. Names that are not in the catalog are ignored,
  and an empty (or entirely unknown) list falls back to the default selection rather than leaving
  the model with no tools.
- **Guided example prompts.** `<AssistantPanel>` shows a few starter questions (e.g. _"What are my
  top meshes this week?"_, _"How's my average FPS?"_) in the empty conversation; each maps to a
  single core tool. Clicking one sends it — a reliable first-run path that also demonstrates the
  agent working. After them come the packaged investigation skills, labelled by title.
- **Keep tool results small — pass `format=summary`.** A tool hands the model every row it asked
  for, and a big heatmap can fill a lot of context on its own. Every generated aggregate tool takes
  a `format` argument ([result formats](/docs/api/query/#result-formats)): `summary` returns a
  bounded digest — top rows, a trend or merged spatial clusters, with shares, the metric's caveats
  and a templated `reading` sentence — capped at the metric's `maxSummaryRows`, so a 500-bin heatmap
  costs the same as a 5-bin one. The tools default to `table`, which keeps every row and adds the
  `meta` block (metric, range, applied filters, sample size, row count, truncation flag) so the
  model can tell what it is looking at; that envelope costs a fixed ~200 characters, it does **not**
  bound the result, so ask for `summary` when the answer could be large. Prefer questions that map
  to a small result and pass `limit` / `scene` / a tight range as well.
- **An evaluated tool catalog.** The tools the assistant hands your model are not just generated —
  they are measured. A bank of 84 real analytics questions is run against a deterministic fixture
  set through this same catalog whenever it changes, and each answer is scored on tool selection,
  argument correctness and accuracy, so a tool description that makes a model pick badly shows up as
  a failed case. The harness is in the repository at
  [`oss/packages/agent-eval`](https://github.com/RaananW/Uptimizr/tree/main/oss/packages/agent-eval).

## Persisting the choice

```ts
import { loadBackendConfig, saveBackendConfig } from "@uptimizr/agent-core/providers";

saveBackendConfig({
  backend: "hosted",
  hosted: {
    api: "anthropic",
    endpoint: "https://api.anthropic.com/v1",
    apiKey: "sk-ant-…",
    model: "claude-3-5-haiku-latest",
  },
});

const config = loadBackendConfig(); // null until the user connects a provider
```

The selection is read back on the next visit so users don't re-enter it each time. Clearing it
(`clearBackendConfig()`) forgets the provider and the stored key.

## Embed in a React app

Prefer not to wire the provider adapter and the tool-calling loop by hand? The
[`@uptimizr/react`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/react/README.md)
component catalog ships a drop-in **`<AssistantPanel>`** and a headless **`useAssistant()`** hook
from a dedicated, code-split subpath (ADR 0047). Importing the core `@uptimizr/react` barrel pulls
**no** assistant or LLM code; only `@uptimizr/react/assistant` does, and the provider adapter is
imported on the first turn — so consumers who never open the assistant pay nothing.

```tsx
import { AssistantPanel } from "@uptimizr/react/assistant";

// Reuses an ambient <UptimizrProvider>, or pass the collector connection directly.
export function Analytics() {
  return <AssistantPanel collectorUrl="http://localhost:4318" apiKey="utk_…" />;
}
```

`<AssistantPanel>` renders the whole surface — on first open, the **provider form**; once a provider
is connected, the message list, input, the privacy note and a **Change provider** control. It reuses
the same read-only [`CollectorApi`](/docs/deploy/dashboard/) client the panels use, so there is no
second transport.

### Knowing when it's working

**Answers stream in.** Replies appear in the conversation word by word as the model produces them
("watch it type") instead of landing all at once at the end. Providers stream over Server-Sent
Events (OpenAI-compatible `stream: true` and the Anthropic Messages stream — parsed with plain
string scans, never a regex over model output). Tool-calling turns are **not** shown as text: a
model's pre-tool commentary is dropped when that turn ends, and only the answer turn renders live.
If a provider or gateway ignores the stream request and returns one JSON body, the answer simply
lands in one piece.

**A status label is always visible** while a turn is in flight (a small spinner in an `aria-live`
region, so it's announced to screen readers — the streamed tokens themselves are deliberately kept
out of that region so a screen reader isn't read every fragment):

- **Running analytics…** while a read-only tool call is executing (the per-tool list is shown too),
- **Thinking…** while the model is composing its answer, becoming
- **Streaming…** once the first tokens of the answer arrive and the live text is rendering.

A model sometimes gathers the data but then stalls — returning an empty answer, or tool-calling
until the step cap without writing a reply. When a run would otherwise end with no usable answer,
the loop makes **one final pass with tools disabled**, which makes the model compose a plain-text
answer from the tool results it already has. Very large tool results are **truncated** (with a
clear marker) before being fed back, to protect the context window. Both behaviors are on by default
in `@uptimizr/agent-core` (`runAgent({ forceFinalAnswer, maxToolResultChars })`).

If a turn still finishes without a natural-language answer, the panel says so explicitly instead of
rendering nothing. It distinguishes two cases from the agent loop's own signals: the model simply
stopped with no text, or it **kept calling tools and hit the step cap** (it reports how many steps
it took and suggests rephrasing, asking for a summary, or connecting a more capable model). The
in-browser panel allows a few more tool-calling turns than the shared default (12 vs.
`@uptimizr/agent-core`'s 8); tune it with `useAssistant({ maxSteps })`. The conversation area
scrolls and auto-follows the newest message, so answers stay in view inside a fixed-height drawer.

For a custom UI, drive the headless hook instead and render your own chat:

```tsx
import { useAssistant } from "@uptimizr/react/assistant";

function MyAssistant() {
  const { messages, send, status, toolActivity, backend, setBackend, isReady } = useAssistant({
    collectorUrl: "http://localhost:4318",
    apiKey: "utk_…",
    // Optional: pass an explicit provider, or omit to load the persisted one.
    // With neither, `backend` stays `null` on first run so you can render your
    // own provider form before anything is sent.
  });
  // messages: the transcript · send(text): run a turn · status: "idle" | "thinking" | "error" ·
  // isBusy: a turn is in flight (show a working indicator) · partialText: the answer streamed so
  // far for the in-flight turn (null when nothing is streaming; render it as the live assistant
  // bubble — it clears in the same render the final turn lands in `messages`, so never both) ·
  // toolActivity: live tool-call progress · notice: {kind:"no_answer"|"stopped_on_max_steps",steps?}
  // when a turn produced no written answer · setBackend(cfg): switch + persist.
}
```

The hook wraps `@uptimizr/agent-core`'s `runAgent` loop, manages message history and per-turn state,
tracks tool-call progress, and persists the provider via the config helpers above. The loop runs
client-side, so it works against both a real collector and the demo's in-browser DuckDB-Wasm query
layer with no server. Point Tailwind at the package source (as the panels require) so the
component's utility classes aren't tree-shaken out.

### Local models (deprecated)

Earlier releases also offered a **local** backend that ran a WebLLM model on the user's GPU. It is
no longer offered by `<AssistantPanel>`
([ADR 0053](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0053-assistant-api-key-providers-only.md)):
the 7–8B models that fit in a browser handled only single-metric questions and needed a multi-GB
download. A local choice saved by an earlier release is not restored; the panel asks for a
provider instead. The library APIs still work and are marked `@deprecated` until the next major
release: `@uptimizr/agent-core/providers/webllm` (`createWebLlmProvider`, `CURATED_MODELS`,
`clearCachedModels`, …), `BackendKind` `"local"`, `isWebGpuAvailable`, `defaultBackendKind`, and
`useAssistant`'s `confirmDownload`, `cachePolicy`, `onCacheEvicted`, `initProgress`,
`webGpuAvailable`, `models` and `clearCachedModels`.

## In the OSS dashboard

The self-hostable [dashboard](/docs/deploy/dashboard/) has the assistant built in — no wiring
required. Once you're connected to a project, open the **Analytics assistant** card at the top of the
overview and click **Ask the assistant**. The panel mounts against that project's existing collector
connection (the same read-only query API and key the panels use) and answers are grounded in real
tool calls against your data.

The assistant is loaded exactly like the portable component above: a lazy `import()` pulls
`@uptimizr/react/assistant` on first open, so the dashboard's main bundle is unchanged for anyone
who never opens it. The first time you open it, the panel asks you to **connect a provider** before
anything is sent; the choice is remembered, and **Change provider** changes it at any time.

### Keeping an answer: "Annotate this", "Save this analysis" and "Pin as panel"

An answer you have to re-derive next week is half an answer. Under every reply the panel offers
these actions:

- **Annotate this** stores the answer as a project note, pinned to whatever the dashboard is
  currently filtered to — the scene you are looking at, or the time window you are showing. The note
  then appears as a marker on the event-volume time axis, with its text as the tooltip, so the next
  person to look at that spike reads the explanation instead of re-deriving it.
- **Save this analysis** stores the turn as a titled record: a title (pre-filled with the question
  you asked), the collector reads the model actually made, and the answer as the conclusion.
- **Pin as panel** keeps the _question_ rather than the answer: it puts the query the model ran on
  the dashboard as a panel, re-asked and redrawn every time somebody opens it. The chart is chosen
  from the metric's grain, the answer becomes the panel's subtitle, and the time range becomes
  `inherit` — so the panel follows the dashboard's own filter bar instead of freezing the window you
  happened to ask in. It is offered only on an answer that came from a `query` tool call, because
  that document is what the panel re-runs; a turn answered from a canned endpoint has nothing to
  pin. The panel is stored as **data, not code** — a metric id, a chart name and some column names,
  drawn with the components the dashboard already ships. See
  [Custom dashboard panels](/docs/guides/custom-panels/#declarative-spec-panels).

All three are shown **only** when the connected key holds the `annotate` capability — the panel
asks `GET /api/v1/whoami` once and hides them otherwise, rather than offering a button that would be
refused. A key minted by `uptimizr init` / `uptimizr new-project` carries it; a read-only key
(`uptimizr new-key`'s default) does not.

Rows written this way are recorded as authored by an **agent**, because the text is the model's — the
collector decides that from the calling client, never from the payload. They are bounded, audited,
and metadata only: nothing here can write, alter or delete an event. See
[Metadata endpoints](/docs/api/metadata/).

### In the backend-less demo

The [live demo](https://demo.uptimizr.com) embeds this same dashboard build, and its `/api/v1/*`
reads are served entirely in the browser by a service worker backed by DuckDB-Wasm (no server, no
account). The assistant works there too: connect your own provider and key, and the tool calls read
from the in-browser store. It is the one part of the demo that sends anything out — when you use it,
your questions and the aggregated results it reads go to the provider you connected, and your key
stays in the tab. A visitor who never opens the assistant sends nothing.

The demo **updates itself automatically**: its service worker serves the app shell network-first, so
reloading the page always picks up the latest deploy (and its latest assistant build) while staying
usable offline after "Prepare demo". If you ever seem stuck on an old build, reload once more, or
force a clean copy via your browser's **Clear site data** / a hard refresh / an incognito window.

## Project context in the system prompt

Before its first answer the assistant reads the collector's
[project context document](/docs/api/context/) and folds a compact rendering of it into the system
prompt. That is what lets the model use **your** names instead of plausible ones:

```text
Project context (read from this collector; prefer these real names over any you infer):

Scenes (use these exact ids for the `scene` filter; region ids for `region`):
- lobby "Main Lobby" [regions: counter, entrance]
- arena

Custom events this app emits (name ×count {props}) — use these exact names:
- add_to_cart ×311 {sku: string, qty: number}

Most-interacted meshes: checkout_button, door_left.

No data is captured for these metrics, so they WILL return empty — say the channel is off rather
than reporting a zero: mesh_dwell, hover_dwell.

Data: last event 4 min ago, 91 sessions in the last 24 h.
Raw session access is OFF on this collector: session timelines and replay cannot be read through the API.
```

The block is deliberately short (≈1.5 k characters at most, truncated on a line boundary if a
project is unusually large), because the same prompt also carries the tool schemas. It is
re-stamped on **every** send, so a context that arrives mid-conversation still reaches the model,
and it sits after the current-time line so the original prompt is unchanged.

The document is fetched once per collector connection and cached server-side for ~30 s, so it costs
almost nothing. A collector **too old to serve `/api/v1/context`** is not an error: the read fails
silently and the assistant runs with exactly the prompt it had before.

`useAssistant` also returns the raw document as `projectContext` (`null` while loading, or when the
endpoint is unavailable), so a host UI can show what the assistant knows:

```tsx
const { projectContext } = useAssistant({ collectorUrl, apiKey });
const scenes = projectContext?.scenes?.map((s) => s.id) ?? [];
```

If you drive `@uptimizr/agent-core` yourself, `renderContextForPrompt(document)` produces the same
block.

## See also

- [MCP server (AI agents)](/docs/guides/mcp/) — the same read-only tool catalog for external/local agents.
- [Project context](/docs/api/context/) — the document the assistant injects, and the endpoint behind it.
- [ADR 0050](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0050-in-browser-analytics-assistant.md) — design rationale and trust boundary.
- [ADR 0053](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0053-assistant-api-key-providers-only.md) — why the assistant connects a provider by API key only.
