---
"@uptimizr/collector-server": minor
---

The project context document (`GET /api/v1/context`) now reports the project's
real glossary and recent annotations.

`#308` shipped the document with a narrow `ProjectMetadataProvider` seam and an
empty default, because the metadata write path did not exist yet; `#310` shipped
that path with `listGlossary(projectId)` and `listAnnotations(projectId, { limit })`
named for exactly this hook-up. `buildApp` now defaults to
`storeProjectMetadata(store)`, so a term written with `PUT /api/v1/glossary/:term`
appears in `definitions.glossary`, and a note left with `POST /api/v1/annotations`
appears in `annotations.recent`, with no route, schema or client change.

Reading the context still needs only `query` — writing is the metadata route's
job and keeps its own `annotate` gate. `EMPTY_PROJECT_METADATA` remains exported
for an embedder with no metadata store, and `buildApp` still accepts a
`projectMetadata` override.
