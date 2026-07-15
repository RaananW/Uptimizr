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

Local is the **privacy-preserving default** when WebGPU is available. When it isn't (older Safari,
Firefox-on-Android, low-RAM devices), the local option is hidden and the hosted backend provides
broader reach at the cost of sending aggregated analytics to your own provider.

```ts
import { defaultBackendKind, isWebGpuAvailable } from "@uptimizr/agent-core/providers";

if (isWebGpuAvailable()) {
  // Offer the local, zero-egress backend.
}
const backend = defaultBackendKind(); // "local" when WebGPU is present, else "hosted"
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
  model: "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
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
**Hermes** family, so the curated set is limited to those variants — ordered smallest-first, so the
default is the least-friction working model. Sizes are approximate (sourced from WebLLM's
`prebuiltAppConfig`) and shown to the user before any download:

| Model                     | Download | VRAM    | Notes                                       |
| ------------------------- | -------- | ------- | ------------------------------------------- |
| Hermes 2 Pro (Mistral 7B) | ~3.9 GB  | ~4.0 GB | Smallest tool-calling model; the default.   |
| Hermes 2 Pro (Llama 3 8B) | ~4.6 GB  | ~5.0 GB | Stronger Llama-3 base; needs a capable GPU. |
| Hermes 3 (Llama 3.1 8B)   | ~4.5 GB  | ~4.9 GB | Highest quality; needs a capable GPU.       |

> **Local mode needs a capable GPU.** WebLLM hard-codes function calling to the Hermes-2-Pro /
> Hermes-3 family (its tool-call prompt and output parser are Hermes-specific), and the smallest of
> those is a 7B model. There is **no small (<3 GB) tool-calling model** in WebLLM, so local mode has
> an inherent floor: a WebGPU device with roughly **5 GB of free VRAM**. On devices that can't meet
> it, use the [hosted backend](#bring-your-own-hosted-backend) instead. The provider validates the
> selected model up front and throws `UnsupportedToolCallingModelError` **before** any weights
> download if it isn't tool-calling-capable.

Small in-browser models do tool-calling adequately but not perfectly — expect good summaries, not
deep analytics (ADR 0050 trade-offs). Call `provider.unload()` to release GPU memory when done.

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

`<AssistantPanel>` renders the whole surface — message list, input, the local-vs-hosted backend and
model picker, the WebLLM download-consent prompt and progress bar, and the privacy note. It reuses
the same read-only [`CollectorApi`](/docs/deploy/dashboard/) client the panels use, so there is no
second transport.

For a custom UI, drive the headless hook instead and render your own chat:

```tsx
import { useAssistant } from "@uptimizr/react/assistant";

function MyAssistant() {
  const { messages, send, status, toolActivity, backend, setBackend, isReady } = useAssistant({
    collectorUrl: "http://localhost:4318",
    apiKey: "proj_…",
    // Optional: pass an explicit backend, or omit to load the persisted choice
    // (falling back to a zero-config local backend when WebGPU is available).
  });
  // messages: the transcript · send(text): run a turn · status: "idle" | "initializing" |
  // "thinking" | "error" · toolActivity: live tool-call progress · setBackend(cfg): switch + persist.
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
the dashboard's main bundle is unchanged for anyone who never opens it. Pick a backend under
**Backend** — local WebLLM (zero egress) or your own hosted key.

### In the backend-less demo

The [live demo](https://demo.uptimizr.com) embeds this same dashboard build, and its `/api/v1/*`
reads are served entirely in the browser by a service worker backed by DuckDB-Wasm (no server, no
account). So the assistant works there too: choose the **Local (WebLLM)** backend and ask away — the
tool calls read from the in-browser store and the model runs on your GPU, with **no server and no API
key**. The model weights download on demand behind the consent prompt the first time you open it, and
are **never** part of the demo's one-time "Prepare demo" precache (ADR 0050 §6) — a visitor who never
opens the assistant downloads nothing extra.

## See also

- [MCP server (AI agents)](/docs/guides/mcp/) — the same read-only tool catalog for external/local agents.
- [ADR 0050](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0050-in-browser-analytics-assistant.md) — design rationale and trust boundary.
