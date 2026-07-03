# ADR 0046: Rendering-technology breakdown from session_start.graphics

- **Status:** Accepted
- **Date:** 2026-06-29
- **Deciders:** Uptimizr maintainers

## Context

ADR 0021 split the graphics story in two: part 1 captures always-on
`session_start.graphics` (`api` / `backend` / `apiVersion` / `shadingLanguage`)
once per session as non-PII, low-cardinality metadata; part 2 adds the opt-in
`graphics_diagnostic` event for GPU-health incidents. #16 surfaced part 2 as the
"Engine diagnostics" dashboard panel, but the always-on capability mix from part 1
was only visible per-session in the SessionInspector — there was no aggregate view
answering "what does my audience render with?".

We need a dialect-agnostic aggregate over the existing always-on data, with no SDK
or schema change, and a dashboard panel that reads sensibly when sessions exist by
default (unlike diagnostics, which is empty until opted in).

## Decision

Aggregate `session_start.graphics` into session counts crossed by `(api, backend,
apiVersion, shadingLanguage)` and surface it as a "Rendering technology" panel
beside Engine diagnostics.

- `@uptimizr/db` gains `buildRenderingTechnology(projectId, opts, dialect)`, a thin
  sibling of `buildGraphicsDiagnosticCounts`. The graphics fields stay in stored
  JSON (nothing promoted to a column, ADR 0004); extraction uses the existing
  `jsonText` helper and blanks `coalesce` to `''` ("unknown"). Parity is locked by
  a `PARITY_CASES` entry.
- A read-only `GET /api/v1/rendering-technology` collector endpoint exposes it; the
  `@uptimizr/react` client folds the rows into by-api / by-backend / by-shading
  projections of one honest session total.
- The panel is always-on, so it has no opt-in empty state — only a neutral "no
  sessions in range" before any data lands.

## Consequences

### Positive

- The capability mix is visible without per-session drilling, on data already on
  the wire — no SDK/schema/migration change.
- Mirrors the diagnostics slice end-to-end, so the seam stays swappable across
  DuckDB/ClickHouse and the dashboard pattern stays uniform.

### Negative / trade-offs

- Four crossed dimensions can fan out; we group all four for fidelity and derive
  coarser projections client-side rather than adding more endpoints.

## Alternatives considered

- **Extend Engine diagnostics instead of a new panel** — conflates opt-in
  incidents with always-on metadata and muddies the empty-state semantics.
- **Group by api/backend only** — simpler, but loses the version/shading-language
  segmentation; we derive coarser views from the richer query instead.
