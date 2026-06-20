---
description: Event schema conventions — the single source of truth for analytics events.
applyTo: "oss/packages/schema/**"
---

# `@uptimizr/schema` — event contracts

This package is the **single source of truth** for every analytics event. Client SDKs, the
collector server, and the replay package all import from here. Never redefine event shapes
elsewhere.

## Rules

- Define every event with **Zod**, and derive TypeScript types via `z.infer`. Export both the
  schema and the inferred type.
- All events share a common **envelope**: `projectId`, `visitorId` (server-set — clients omit
  it), `sessionId`, `ts` (epoch ms), `sdkVersion`, `url`, and `pageMeta`.
- Events must be **replay-complete**: ordered, timestamped, and keyed by `sessionId`, with enough
  fidelity to reconstruct a session (camera pose, pointer position, picked mesh, etc.). See
  ADR 0006.
- v1 event types: `session_start`, `session_end`, `frame_perf`, `camera_sample`, `pointer_move`,
  `pointer_click`, `mesh_interaction`, `asset_load`, `custom`. Use a discriminated union on a
  `type` field.
- Keep numeric payloads compact (e.g. arrays of numbers for vectors) — these are high-volume.
- The package must stay **dependency-light** (Zod only) and free of any DOM, Node, Babylon, or
  server imports, so it can run in browser, server, and edge contexts.

## When adding/changing an event

1. Update the Zod schema + union here first; bump types.
2. Thread the change through `sdk-core`, `@uptimizr/babylon`, `collector-server`, `@uptimizr/db`
   (storage), and `@uptimizr/replay` as needed.
3. Add/extend unit tests validating the new schema.
4. If the change is significant or alters semantics, add an ADR.
