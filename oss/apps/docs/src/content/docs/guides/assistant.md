---
title: In-browser assistant (LLM)
description: Ask natural-language questions of your 3D analytics with a client-side agent, powered by a local WebGPU model or your own hosted LLM key. No Uptimizr backend, no default data egress.
---

The in-browser assistant lets anyone ask natural-language questions of their 3D analytics
("what were the most-clicked meshes this week, and how's the average FPS?") **without** installing an
MCP client. The agent loop runs entirely in the browser against the same read-only
[query API](/docs/api/query/) a human dashboard user sees — one project, aggregate-only, no raw
events, no PII.

It ships **no model and no key**. You pick a backend, and the choice persists per-user in
`localStorage`. Everything is user-controlled, so there is no Uptimizr-operated backend and no
default egress (ADR 0050 §4/§5).

The two backends are provider adapters for [`@uptimizr/agent-core`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/agent-core/README.md),
imported from code-split subpaths so consumers who never use the assistant pay nothing for it:

```ts
import { createWebLlmProvider } from "@uptimizr/agent-core/providers/webllm";
import { createHostedProvider } from "@uptimizr/agent-core/providers/hosted";
```

## Choosing a backend

| Backend                     | Where inference runs     | What leaves the browser              | Requirements             |
| --------------------------- | ------------------------ | ------------------------------------ | ------------------------ |
| **Local (WebLLM / WebGPU)** | Your GPU, in the browser | **Nothing** — zero egress            | A WebGPU-capable browser |
| **Bring-your-own hosted**   | Your chosen LLM provider | Prompt + **aggregated** results only | Provider key + CORS      |

There is **no default backend** — the first time you open the `<AssistantPanel>` it presents an
explicit **first-run chooser** with both options side by side and their honest tradeoffs, and
**nothing is loaded or downloaded until you pick** (ADR 0050 §4, amended). This avoids surprising a
first-time user with a multi-GB local model download. When WebGPU is present the local option is
highlighted as _Recommended_ (it is the zero-egress choice); when it isn't (older Safari,
Firefox-on-Android, low-RAM devices) the local option is shown **disabled** with a "requires a
WebGPU browser" note, and the hosted backend provides broader reach at the cost of sending
aggregated analytics to your own provider. Your choice persists, so returning users go straight to
the chat. You can change it — including switching between local and hosted — at **any time** via
**Change backend**, which returns you to the same side-by-side selection cards; picking the other
backend releases the previous model (freeing GPU memory) and activates the new one.

```ts
import { defaultBackendKind, isWebGpuAvailable } from "@uptimizr/agent-core/providers";

if (isWebGpuAvailable()) {
  // Offer (and, if you like, highlight) the local, zero-egress backend — but let
  // the user choose; don't auto-select it.
}
const suggested = defaultBackendKind(); // "local" when WebGPU is present, else "hosted"
```

## Local backend (WebLLM / WebGPU)

The heavy [`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm) runtime is an **optional** dependency
loaded via a lazy `import()` only when you actually run the assistant. Model weights download **on
first use**, behind an explicit consent prompt, and are cached by the runtime in the browser's
**Cache Storage** — they are **never** part of any precache (including the demo's "Prepare demo"
step, ADR 0050 §6). Inference runs on your GPU; **nothing leaves the browser**.

```ts
import { CURATED_MODELS, createWebLlmProvider } from "@uptimizr/agent-core/providers/webllm";

const provider = createWebLlmProvider({
  model: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
  // Called once, before any weights download. Show the size disclosure and
  // return false to abort — no data is downloaded if the user declines.
  confirmDownload: (model) =>
    confirm(`Download ${model.label} (${model.downloadSize})? It runs 100% locally.`),
  onInitProgress: ({ progress, text }) => updateProgressBar(progress, text),
});
```

Install the runtime alongside the assistant (it is an optional peer dependency):

```bash
npm install @mlc-ai/web-llm
```

### Curated models

WebLLM only supports the tool-calling (function calling) the assistant relies on for the 7–8B
**Hermes** family, so the curated set is limited to those variants — ordered **strongest-first**, so
the default is the best tool-caller (which most reliably answers even simple single-step questions on
a small 4-bit local model). Sizes are approximate (sourced from WebLLM's `prebuiltAppConfig`) and
shown to the user before any download:

| Model                     | Download | VRAM    | Notes                                       |
| ------------------------- | -------- | ------- | ------------------------------------------- |
| Hermes 3 (Llama 3.1 8B)   | ~4.5 GB  | ~4.9 GB | Highest quality; **the default**.           |
| Hermes 2 Pro (Llama 3 8B) | ~4.6 GB  | ~5.0 GB | Stronger Llama-3 base; needs a capable GPU. |
| Hermes 2 Pro (Mistral 7B) | ~3.9 GB  | ~4.0 GB | Smallest tool-calling model; least-VRAM.    |

> **Local mode needs a capable GPU.** WebLLM hard-codes function calling to the Hermes-2-Pro /
> Hermes-3 family (its tool-call prompt and output parser are Hermes-specific), and the smallest of
> those is a 7B model. There is **no small (<3 GB) tool-calling model** in WebLLM, so local mode has
> an inherent floor: a WebGPU device with roughly **5 GB of free VRAM**. On devices that can't meet
> it, use the [hosted backend](#bring-your-own-hosted-backend) instead. The provider validates the
> selected model up front and throws `UnsupportedToolCallingModelError` **before** any weights
> download if it isn't tool-calling-capable.

Small in-browser models do tool-calling adequately but not perfectly — expect good summaries, not
deep analytics (ADR 0050 trade-offs). Call `provider.unload()` to release GPU memory when done.

### Getting good answers from the local model

Small local models shine at **single-step** questions and struggle with long, multi-tool analysis.
The assistant is tuned for that reality:

- **Current-time grounding.** The system prompt is stamped with the current time (ISO 8601 + epoch
  ms) at send time, so relative ranges like _"today"_, _"this week"_, or _"the last 24 hours"_
  resolve to concrete `since`/`until` epoch-millisecond arguments instead of being dropped or
  guessed. The stamp is refreshed on **every** send — the conversation's single system message is
  updated in place, never duplicated — so a long-lived conversation that crosses midnight keeps
  resolving _"today"_ against the real current day. The clock is injectable via
  `useAssistant({ now })` for deterministic tests, and the pure `refreshSystemPrompt()` helper
  (`messages, basePrompt, nowMs`) is exported for custom loops.
- **A focused core tool set.** The full catalog has 20 read tools; sending them all overwhelms a
  4-bit 7–8B model's function-calling prompt. For the **local** backend the assistant exposes a
  focused **core subset** of the most common single-step tools — `list_sessions`, `list_scenes`,
  `top_meshes`, `perf_summary`, `event_counts`, `timeseries`, and `camera_heatmap`. The **hosted**
  backend keeps the full 20 (frontier models handle them). The core set is a **filtered view** of
  the same tool definitions — nothing is redefined (`selectReadTools("core")` / `coreReadTools` in
  `@uptimizr/agent-core`).
- **Guided example prompts.** `<AssistantPanel>` shows a few starter questions (e.g. _"What are my
  top meshes this week?"_, _"How's my average FPS?"_) in the empty conversation; each maps to a
  single core tool. Clicking one sends it — a reliable first-run path that also demonstrates the
  agent working.

> **Local mode is for quick, single-metric answers.** Use it for _"top meshes this week"_, _"average
> FPS"_, or _"events in the last 24h"_. For deeper, multi-step analysis, switch to a
> [hosted backend](#bring-your-own-hosted-backend) with your own key at any time via **Change
> backend** — the frontier model gets the full tool catalog. This is a capability trade-off, not an
> error.

> **The local context window is raised to fit the assistant's prompt.** WebLLM loads the curated
> Hermes model records with a default `context_window_size` of 4096 tokens, but the assistant's
> prompt — its system instructions plus the tool JSON schemas and any tool results — runs past
> that (a "Prompt tokens exceed context window size" error). The Hermes 7–8B models natively
> support 8k+ context, so the adapter loads the engine with an **8192-token** window
> (`DEFAULT_LOCAL_CONTEXT_WINDOW`), overriding the model-record default. Hosts can tune it via
> `createWebLlmProvider({ contextWindowSize })` — raise it only up to what the selected model
> actually supports.

> **Local models need browser storage — plan for ~4–5 GB per model.** WebLLM caches a model's
> weights in your browser's **Cache Storage** on first use, and each curated model is roughly
> **4–5 GB**. Trying several models (or switching between them) **accumulates** their caches rather
> than replacing them, so the origin's storage quota can fill up. When it does, the browser's Cache
> API throws a storage-quota error — this is a **browser storage** limit, not an LLM API quota (the
> local backend has zero network egress), and the assistant surfaces it with a clear remedy. To
> reclaim space, free up disk space or **clear this site's cached data** (your browser's
> Settings → Privacy → _Clear site data / storage_), then retry — or pick the smallest model or a
> hosted backend. Before a large download the adapter also runs a best-effort
> `navigator.storage.estimate()` preflight and fails fast when free space is clearly insufficient,
> avoiding a corrupt half-download.

> **Local models manage their own function-calling system prompt.** WebLLM injects its own
> tool-calling system prompt for the Hermes family and rejects a caller-supplied `system` message
> whenever tools are present. So for the local backend the assistant's system instructions are
> merged into the first user turn instead of sent as a `system` role — a WebLLM constraint that is
> transparent to you. Hosted backends receive the system prompt as usual, which is why the local
> vs hosted framing can differ slightly under the hood.

## Bring-your-own hosted backend

You supply an **OpenAI-compatible** or **Anthropic** endpoint + key. The key and endpoint are stored
**only in your browser** (`localStorage`) and the browser calls **your own** provider directly —
Uptimizr operates no proxy. Only the prompt and the **aggregated** tool results the loop produces
leave, and only to the provider you chose (never raw events or PII, ADR 0050 §5).

```ts
import { createHostedProvider } from "@uptimizr/agent-core/providers/hosted";

// OpenAI-compatible
const openai = createHostedProvider({
  api: "openai",
  endpoint: "https://api.openai.com/v1", // or a self-hosted / gateway URL
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

### Required provider CORS

Because the request originates in the browser, the provider must allow cross-origin calls:

- **Anthropic** — the adapter sends the `anthropic-dangerous-direct-browser-access: true` header,
  which enables Anthropic's browser CORS path. No proxy needed.
- **OpenAI-compatible** — `api.openai.com` does **not** send permissive CORS headers, so calling it
  directly from a browser is blocked. Use a provider/gateway that returns
  `Access-Control-Allow-Origin` for your dashboard's origin (many self-hosted servers and LLM
  gateways do), or run the assistant against such an endpoint.

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

const config = loadBackendConfig(); // null until the user picks a backend
```

The selection is read back on the next visit so users don't re-choose each time. Clearing it
(`clearBackendConfig()`) forgets the backend and any stored key.

## Embed in a React app

Prefer not to wire the provider adapters and the tool-calling loop by hand? The
[`@uptimizr/react`](https://github.com/RaananW/Uptimizr/blob/main/oss/packages/react/README.md)
component catalog ships a drop-in **`<AssistantPanel>`** and a headless **`useAssistant()`** hook
from a dedicated, code-split subpath (ADR 0047). Importing the core `@uptimizr/react` barrel pulls
**no** assistant or LLM code; only `@uptimizr/react/assistant` does, and even then `@mlc-ai/web-llm`
stays lazy until a local model runs — so consumers who never open the assistant pay nothing.

```tsx
import { AssistantPanel } from "@uptimizr/react/assistant";

// Reuses an ambient <UptimizrProvider>, or pass the collector connection directly.
export function Analytics() {
  return <AssistantPanel collectorUrl="http://localhost:4318" apiKey="proj_…" />;
}
```

`<AssistantPanel>` renders the whole surface — on first open, the **backend chooser** (both options
with their tradeoffs); once a backend is picked, the message list, input, the local-vs-hosted backend
and model picker, the WebLLM download-consent prompt and progress bar, and the privacy note. It
reuses the same read-only [`CollectorApi`](/docs/deploy/dashboard/) client the panels use, so there
is no second transport.

### Knowing when it's working

Local generation is **not** instant. The in-browser model does not stream tokens, so a single
answer on a 7–8B Hermes model can take anywhere from a few seconds to a couple of minutes on
modest hardware — with nothing sent to a server in the meantime. To make that obvious rather than
looking frozen, the panel always shows a small spinner and a status label while a turn is in
flight (in an `aria-live` region, so it's announced to screen readers):

- **Loading model…** while a local model downloads/initializes (a progress bar replaces it once
  download progress is available),
- **Running analytics…** while a read-only tool call is executing (the per-tool list is shown too),
- **Thinking…** while the model is composing its answer.

Small local models sometimes gather the data but then stall — either returning an empty answer or
tool-calling until the step cap without ever writing a reply. To fix that at the source, when a run
would otherwise end with no usable answer the loop makes **one final pass with tools disabled**,
which forces the model to compose a plain-text answer from the tool results it already gathered
rather than reaching for another tool call. This forced pass is still local for the local backend,
so there is no new data egress. To protect the local model's context window, very large tool
results are **truncated** (with a clear marker) before being fed back — full fidelity is kept below
the cap. Both behaviors are on by default in `@uptimizr/agent-core` (`runAgent({ forceFinalAnswer,
maxToolResultChars })`). Even so, **hosted backends handle complex, multi-step questions more
reliably** than the small local models — reach for one when a local model keeps coming up short.

If a turn ever finishes without a natural-language answer, the panel says so explicitly instead
of rendering nothing, so a reply is never silently dropped. It distinguishes two cases from the
agent loop's own signals: the model simply stopped with no text, or it **kept calling tools and
hit the step cap** (it reports how many steps it took and suggests rephrasing, asking for a
summary, or switching to a hosted model). The in-browser panel allows a few more tool-calling
turns than the shared default (12 vs. `@uptimizr/agent-core`'s 8) so a small local model has room
to wrap up; tune it with `useAssistant({ maxSteps })`. The conversation area scrolls and
auto-follows the newest message, so answers stay in view inside a fixed-height drawer.

For a custom UI, drive the headless hook instead and render your own chat:

```tsx
import { useAssistant } from "@uptimizr/react/assistant";

function MyAssistant() {
  const { messages, send, status, toolActivity, backend, setBackend, isReady } = useAssistant({
    collectorUrl: "http://localhost:4318",
    apiKey: "proj_…",
    // Optional: pass an explicit backend, or omit to load the persisted choice.
    // With neither, `backend` stays `null` on first run (no auto-select) so you
    // can render your own chooser before anything loads.
  });
  // messages: the transcript · send(text): run a turn · status: "idle" | "initializing" |
  // "thinking" | "error" · isBusy: a turn is in flight (show a working indicator) · toolActivity:
  // live tool-call progress · notice: {kind:"no_answer"|"stopped_on_max_steps",steps?} when a turn
  // produced no written answer · setBackend(cfg): switch + persist.
}
```

The hook wraps `@uptimizr/agent-core`'s `runAgent` loop, manages message history and per-turn state,
tracks tool-call and WebLLM download progress, and persists the backend choice via the config helpers
above. The loop runs client-side, so it works against both a real collector and the demo's in-browser
DuckDB-Wasm query layer with no server. Point Tailwind at the package source (as the panels require)
so the component's utility classes aren't tree-shaken out.

## In the OSS dashboard

The self-hostable [dashboard](/docs/deploy/dashboard/) has the assistant built in — no wiring
required. Once you're connected to a project, open the **Analytics assistant** card at the top of the
overview and click **Ask the assistant**. The panel mounts against that project's existing collector
connection (the same read-only query API and key the panels use) and answers are grounded in real
tool calls against your data.

The assistant is loaded exactly like the portable component above: a lazy `import()` pulls
`@uptimizr/react/assistant` (and, only when a local model runs, `@mlc-ai/web-llm`) on first open, so
the dashboard's main bundle is unchanged for anyone who never opens it. The first time you open it,
the panel asks you to **choose a backend** — local WebLLM (zero egress) or your own hosted key —
before anything loads; the choice is remembered, and you can change it — or switch between local and
hosted — at any time via **Change backend**.

### In the backend-less demo

The [live demo](https://demo.uptimizr.com) embeds this same dashboard build, and its `/api/v1/*`
reads are served entirely in the browser by a service worker backed by DuckDB-Wasm (no server, no
account). So the assistant works there too: choose the **Local (WebLLM)** backend and ask away — the
tool calls read from the in-browser store and the model runs on your GPU, with **no server and no API
key**. The model weights download on demand behind the consent prompt the first time you open it, and
are **never** part of the demo's one-time "Prepare demo" precache (ADR 0050 §6) — a visitor who never
opens the assistant downloads nothing extra.

The demo **updates itself automatically**: its service worker serves the app shell network-first, so
reloading the page always picks up the latest deploy (and its latest assistant build) while staying
usable offline after "Prepare demo". If you ever seem stuck on an old build, reload once more, or
force a clean copy via your browser's **Clear site data** / a hard refresh / an incognito window.

## See also

- [MCP server (AI agents)](/docs/guides/mcp/) — the same read-only tool catalog for external/local agents.
- [ADR 0050](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0050-in-browser-analytics-assistant.md) — design rationale and trust boundary.
