# ADR 0053: The assistant connects a provider by API key only

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Project owner, engineering
- **Supersedes:** the local (WebLLM / WebGPU) backend of [ADR 0050](./0050-in-browser-analytics-assistant.md)
  §4, §5 and §6, and its 2026-07-15 amendment (the two-card first-run chooser). The rest of ADR 0050
  stands: one tool contract for three consumers, packaged for reuse, client-side with no new server
  component, and the privacy boundary for a hosted provider.

## Context

ADR 0050 gave the in-browser assistant two user-controlled backends: a local model running in the
browser through WebLLM and WebGPU, and the user's own hosted provider reached with an API key. The
local backend was meant to be the privacy-first default, and it was the demo's headline: "the
assistant runs 100% locally".

In practice the local backend did not work well. The models that fit a browser (8B parameters,
4-bit, about 4 GB of weights and 5 GB of VRAM) could not drive the tool catalog reliably:

- They answered only single-metric questions. Anything multi-step looped on tool calls until the
  step cap and stopped with no answer, which is why the panel grew a "stopped after N steps"
  notice, a "quick, single-metric questions" capability note and a tool-activity compactor for
  `top_meshes ×12`.
- Even then they needed a reduced catalog (`coreReadTools`), so the local assistant could reach
  less of the data than a hosted one.
- First use cost a multi-GB download behind a consent dialog, needed a WebGPU browser with enough
  free VRAM, and could fail on the origin's storage quota, which needed its own error UI and a
  "clear cached models" control.

The result was an assistant whose default path was the one most likely to disappoint.

## Decision

The assistant connects to the user's **own model provider by API key**, and nothing else.

1. `<AssistantPanel>` offers one form: an OpenAI-compatible or Anthropic endpoint, an API key and
   a model. The two-card chooser, the local model picker, the download-consent dialog, the progress
   bar, the storage-quota error and the cache controls are removed. The form says up front that
   questions and the aggregated results the assistant reads go to that provider (never raw events
   or PII), and that the key stays in the browser.
2. A local choice persisted before this change is **not restored**: the user is asked to connect a
   provider instead of the panel starting a download. A local backend passed to the panel
   explicitly is treated the same way.
3. The library APIs stay, **deprecated**, until the next major release of each package, so no
   existing caller breaks in a minor release:
   - `@uptimizr/agent-core`: the `providers/webllm` subpath (`createWebLlmProvider`,
     `CURATED_MODELS`, `clearCachedModels`, …), `BackendKind` `"local"`, `WebLlmBackendConfig`,
     `isWebGpuAvailable` and `defaultBackendKind`.
   - `@uptimizr/react/assistant`: `useAssistant`'s `confirmDownload`, `cachePolicy` and
     `onCacheEvicted` options and its `initProgress`, `webGpuAvailable`, `models` and
     `clearCachedModels` results. The hook still runs a local backend that a host passes to it
     explicitly.
4. The demo keeps the assistant. Since it can no longer run locally, the demo says plainly that the
   assistant is the one part of it that sends anything out, and only when the visitor connects a
   provider of their own.

## Consequences

### Positive

- The assistant's only path is the one that answers multi-step questions, with the full tool
  catalog.
- No multi-GB download, no WebGPU or VRAM requirement and no storage-quota failure mode. The panel
  is smaller and has one first-run step.
- Nothing breaks for library callers in this release; the removal lands in a planned major.

### Negative / trade-offs

- There is no zero-egress assistant any more. Using the assistant always sends the question and
  aggregated results to the user's provider. The data scope is unchanged (one project, aggregates
  only, no raw events, no PII; ADR 0003), but privacy-sensitive users who relied on the local model
  lose it.
- The demo's assistant needs the visitor's own API key, so fewer visitors will try it, and the demo
  can no longer say that nothing at all leaves the browser.
- The deprecated WebLLM code stays in the packages until the next major release.

## Alternatives considered

- **Keep both backends and default to hosted.** It keeps the weakest path one click away, with all
  of its UI (consent, progress, quota errors, cache controls), for answers that rarely satisfy.
- **Delete the WebLLM adapter and its hook options now.** Cleaner, but it removes public exports
  from two published 1.x packages and forces a major release of each for a product decision. The
  deprecation gets the product change out now and leaves the removal to a planned major.
- **Hide the assistant in the demo.** It would keep the demo's strict "nothing leaves your
  browser" line, but hide the feature from the people most likely to evaluate it. A clear notice
  keeps the choice with the visitor.
