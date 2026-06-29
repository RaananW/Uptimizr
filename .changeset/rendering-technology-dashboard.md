---
"@uptimizr/db": minor
"@uptimizr/react": minor
---

Surface the always-on rendering-technology mix in the dashboard (#120, ADR 0021 part 1). Adds a
dialect-agnostic `buildRenderingTechnology(projectId, opts, dialect)` aggregation to `@uptimizr/db`
that rolls `session_start.graphics` up into `(api, backend, api_version, shading_language)` session
counts. The fields ride in stored JSON (nothing promoted to a column), so extraction goes through the
existing `jsonText` helper and blanks coalesce to `''` ("unknown"), covered by a `PARITY_CASES`
entry. Unlike the opt-in engine-diagnostics rollup this is always-on, so a populated result is the
common case.

`@uptimizr/react` gains a `renderingTechnology()` query-client method (and `RenderingTechnologyCount`
type) hitting the new `GET /api/v1/rendering-technology` collector endpoint, powering the new
dashboard "Rendering technology" panel beside Engine diagnostics — sessions broken down by API,
backend, and shading language with no opt-in empty state.
