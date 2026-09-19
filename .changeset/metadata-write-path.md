---
"@uptimizr/collector-server": minor
"@uptimizr/db-clickhouse": minor
"@uptimizr/db-postgres": minor
"@uptimizr/db-mssql": minor
"@uptimizr/agent-core": minor
"@uptimizr/schema": minor
"@uptimizr/dashboard": minor
"@uptimizr/react": minor
"@uptimizr/mcp": minor
"@uptimizr/db": minor
---

Add the **metadata write path** — annotations, a project glossary and saved analyses — so people
and agents can leave something behind instead of re-deriving it every session. Events stay
read-only; these are the only rows a request can write besides ingestion, and every write needs a
key holding the `annotate` capability and is recorded in the agent audit log (ADR 0051 §5/§9).

- `@uptimizr/schema`: `annotationSchema` (`targetKind: project|scene|mesh|region|metric|window`,
  optional `targetId`, `since`/`until`, bounded `text`), `glossaryEntrySchema`,
  `savedAnalysisSchema` and `metadataAuthorKindSchema` — config/metadata shapes, deliberately
  outside the event union — plus the per-field and per-project bounds in `LIMITS`.
- `@uptimizr/db` and the optional Postgres / SQL Server / ClickHouse stores: `annotations`,
  `glossary` and `saved_analyses` tables (forward-only, idempotent migrations) with
  `createAnnotation` / `listAnnotations` / `deleteAnnotation`, `putGlossaryEntry` / `listGlossary` /
  `deleteGlossaryEntry` and `createSavedAnalysis` / `listSavedAnalyses` / `deleteSavedAnalysis`.
  Each store enforces the per-project caps (500 annotations, 200 glossary terms, 200 analyses) at
  write time and throws `MetadataLimitError` when a project is full.
- `@uptimizr/collector-server`: `GET`/`POST`/`DELETE /api/v1/annotations[/:id]`,
  `GET /api/v1/glossary` with `PUT`/`DELETE /api/v1/glossary/:term`, and
  `GET`/`POST`/`DELETE /api/v1/analyses[/:id]`. Writes require `annotate`, reads `query`; payloads
  are Zod-bounded at the edge and a full project answers `409`. Stored rows record whether a person
  or an agent wrote them, decided from the calling client rather than the payload. The served
  OpenAPI document describes the whole group.
- `@uptimizr/agent-core` and `@uptimizr/mcp`: a new `writeTools` catalog (`annotate`, `define_term`,
  `save_analysis`, plus `list_annotations`, `list_glossary`, `list_analyses`), kept a **separate
  export** from the read-only `readTools` so an integration's read-only stance stays inspectable.
  The MCP server calls `GET /api/v1/whoami` at start-up and registers them only when the key holds
  `annotate`; the collector client gains `post`/`put`/`delete` used by these tools alone.
- `@uptimizr/react`: `CollectorApi.whoami` / `.annotations` / `.createAnnotation` / `.glossary` /
  `.defineTerm` / `.analyses` / `.saveAnalysis`, the assistant actions "Annotate this" and "Save
  this analysis" (shown only for an `annotate` key), `annotationTargetFor(filters)`, and annotation
  markers on the event-volume time axis.
- `@uptimizr/dashboard`: the assistant drawer passes the active filters through, so an
  "Annotate this" note is pinned to the scene or window the user is looking at.
