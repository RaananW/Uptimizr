# ADR 0021: Graphics backend metadata and opt-in engine diagnostics

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Project owner, engineering

## Context

Uptimizr is analytics for the 3D world, so the **rendering technology** a session runs on is a
first-class segmentation dimension — arguably as important as the browser or device. Today we
capture only a coarse hint: `device.engine` on `session_start` is `webgl2 | webgpu | webgl |
unknown` ([`sessionStart.ts`](../../oss/packages/schema/src/events/sessionStart.ts)). That conflates
the **graphics API surface** (WebGL vs WebGPU) and says nothing about the **real backend** beneath
it (a WebGPU context may be backed by Metal, D3D12, or Vulkan), the **API version**, or the
**shading language**. It also does not generalize to native engines (Unity/Unreal on
OpenGL/DirectX/Vulkan/Metal), which is on the connector roadmap (ADR 0018, epic #19).

Separately, [ADR 0018](./0018-coordinate-frame-and-connector-provenance.md) established the pattern
for this kind of signal: record **provenance as metadata on `session_start`, beside the
`connector` block**, engine-agnostic so every connector populates it from its own runtime. The
graphics backend is the same shape of fact and should follow the same pattern.

Two distinct things are easy to conflate and must be separated, because they have very different
**cost** and **privacy** profiles:

1. **Backend identity** — _what_ technology renders the scene (API, backend, versions). Tiny,
   low-cardinality, captured once, non-PII. Belongs with the other always-on metadata.
2. **Engine diagnostics** — _how healthy_ that technology is at runtime (GPU errors/warnings,
   shader-compile/link failures, context-loss detail, WebGPU `uncapturederror`,
   `gl.getError()` samples). Potentially high-volume, can stall the GPU (WebGL `getError` forces a
   sync flush), and error/shader text can leak application IP — the same hazards ADR 0013 (error
   capture) and ADR 0012 (sampling/fidelity) already address for JS errors.

We already have the narrow, high-value slice of (2): `context_lost` / `context_restored`
([`contextLoss.ts`](../../oss/packages/schema/src/events/contextLoss.ts)).

## Decision

### 1. Add a `graphics` backend block to `session_start` — always-on metadata (per session)

Introduce an optional `graphics` block on `session_start`, captured **once per session, beside
`connector`** (not per scene — the backend is a property of the engine/canvas, and reporting it
per `scene_change` adds cost for a value that effectively never changes mid-session). It generalizes
`device.engine` and is engine-agnostic so native connectors can fill it too. Indicative shape
(finalized during implementation):

- `api` — the rendering API surface: `webgl | webgl2 | webgpu | opengl | opengles | d3d11 | d3d12
| vulkan | metal | unknown`.
- `backend` — the **real** backend behind an abstraction when discoverable (e.g. WebGPU →
  `metal | d3d12 | vulkan`), via WebGPU adapter info / unmasked renderer heuristics.
- `apiVersion` — version string when exposed (e.g. GL version, WebGPU feature level).
- `shadingLanguage` — `glsl | glsl-es | wgsl | hlsl | msl | spirv | unknown`.

This is **non-PII, low-cardinality metadata** and is therefore **on by default**, exactly like
`device.engine` and the `connector` block. It rides along in the stored `session_start` JSON
payload, so **no database migration is required** (same as ADR 0018). `device.engine` is retained
for backward compatibility and is treated as the legacy summary of `graphics.api`.

### 2. Engine diagnostics are a separate, opt-in event class

Runtime graphics **diagnostics** (GPU errors/warnings, shader-compile failures, richer
context-loss reasons, WebGPU `uncapturederror`, sampled `gl.getError()`) are **not** part of the
always-on metadata. They are introduced as a separate, engine-agnostic event class that is
**opt-in**, mirroring ADR 0013's stance on JS error capture:

- **Off by default.** Enabled by the deployer via an explicit capture flag.
- **Redaction at the boundary.** Free-text (messages, shader source) is length-capped and passes
  through the `beforeSend` hook; the deployer owns redaction. Capturing raw shader source is itself
  a sub-option, off by default, because it can expose application IP.
- **Rate-limited / sampled.** Subject to ADR 0012 sampling and per-category rate limits so a
  per-frame `uncapturederror` storm cannot flood ingestion; a per-session rollup
  ("N validation errors, first = X") is the cheap default, with discrete ordered markers when
  fidelity is needed.
- **Backend-aware capture.** WebGPU uses cheap async error scopes / `uncapturederror`; WebGL avoids
  per-frame `gl.getError()` (a sync GPU stall) in favour of opportunistic sampling. Connectors
  choose the mechanism; the **event shape stays uniform**.
- `context_lost` / `context_restored` are reframed as the first, already-shipped category of this
  class and are exempt from the opt-in (they are rare, decisive, and carry no app text).

### 3. Portability to native engines

Both pieces are defined as **engine-agnostic schema, populated per connector** (the ADR 0011 /
ADR 0018 pattern). A web connector fills `graphics` from the WebGL/WebGPU context and adapter info;
a Unity connector fills it from `SystemInfo.graphicsDeviceType` / `graphicsDeviceVersion` and maps
its graphics-device callbacks into the diagnostics class. Native standalone (non-browser) builds
stress `sdk-core`'s browser transport/lifecycle assumptions — that is a connector-level concern,
**out of scope here**, and tracked separately.

## Consequences

### Positive

- Sessions are segmentable by real rendering technology (API, backend, version, shading language),
  not just `webgl2`/`webgpu` — high-value for a 3D analytics product, and correlatable with the
  existing `device`, `frame_perf`, `scene_id`, and `connector` dimensions.
- Backend metadata is cheap, default-on, migration-free, and ports cleanly to native connectors.
- Diagnostics get a principled home with the cost/privacy guardrails (opt-in, redaction, sampling)
  reused from ADRs 0012/0013, instead of being bolted onto the metadata.

### Negative / trade-offs

- "Real backend" detection on the web is heuristic (unmasked renderer strings, adapter info) and
  may be `unknown` where the browser withholds it — values must be treated as best-effort.
- Two related-but-separate surfaces (metadata vs. diagnostics) is more concept to document so the
  always-on/opt-in boundary is not blurred.
- Adds another optional `session_start` block; consumers must treat it as optional/forward-compatible.

## Alternatives considered

- **Just widen `device.engine`'s enum.** Rejected: it cannot express backend-behind-abstraction,
  version, or shading language, and overloading one field blurs API vs. backend.
- **One combined "graphics" event covering identity + diagnostics.** Rejected: identity is
  always-on, tiny, non-PII; diagnostics are opt-in, potentially noisy, and IP-sensitive. Different
  default and privacy posture ⇒ different surfaces.
- **Capture diagnostics by default.** Rejected: WebGL `getError` cost, `uncapturederror` volume,
  and shader/error-text IP leakage make default-on capture unsafe (consistent with ADR 0013).
- **Per-scene backend reporting.** Rejected for now: the backend is engine/canvas-scoped and rarely
  changes mid-session; per-`scene_change` reporting adds cost for a near-constant value. Revisit if
  multi-canvas/multi-engine apps prove it varies per area.
