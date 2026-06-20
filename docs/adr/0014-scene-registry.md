# ADR 0014: Scene registry and the scene-proxy wire format

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

[ADR 0010](./0010-spatial-3d-heatmaps.md) adds an event-level `scene_id` dimension and a
world-space (3D) heatmap, but explicitly defers the **scene representation tiers** and the
**scene registry** to the mutable
[design sketch](../phases/3d-heatmap-rendering-design.md) as rendering/representation concerns.

The first 3D viewers are now landing:

- **Tier 0 — live overlay** (`@uptimizr/heatmap`): the developer draws heat directly in their
  own running scene. Zero geometry leaves the app.
- **Tier 1 — data-only dashboard viewer**: the dashboard's `WorldHeatmap3D` renders a thermal
  voxel cloud with no scene behind it.

Tier 1 answers _"where are the hotspots"_ but often not _"what object is that."_ To give the
dashboard a recognizable backdrop **without** shipping real art (Tier 3), we need the **Tier 2
proxy**: a compact, structural description of the scene that the dashboard can draw under the
heat. That proxy has to be **stored somewhere keyed by scene**, and it has to travel over the wire
in a **stable, validated shape** that both the SDK producer (`scanSceneProxy`) and the dashboard
consumer agree on.

Two things here are costly to reverse and therefore belong in an ADR rather than the design
sketch: (1) the **persisted shape** of a stored scene representation (a new Postgres table), and
(2) the **wire contract** for a scene proxy (a versioned Zod schema clients depend on). The
remaining choices — proxy _technique_ (AABB vs hull vs voxelization), color ramps, camera framing
— stay mutable in the design sketch.

## Decision

### 1. A scene registry table (Postgres, metadata)

Scene representations are **per-project metadata**, not events, so they live in Postgres (ADR
0002), not ClickHouse. Migration `0008_scene_representations` adds:

- `scene_representations (project_id, scene_id, label, kind, up_axis, unit_scale, bounds, proxy,
asset_url, content_hash, proxy_version, captured_at, updated_at)`, primary key
  `(project_id, scene_id)`, `project_id` foreign-keyed to `projects` with `ON DELETE CASCADE`.
- `kind` is one of `none | proxy | asset`, anticipating Tier 3 (`asset_url`) without committing to
  it now. `bounds` and `proxy` are `JSONB`.
- A scene has **at most one** current representation; re-registering **upserts**
  (`ON CONFLICT (project_id, scene_id) DO UPDATE`). History/versioning is intentionally out of
  scope — the live scene is the source of truth and the proxy is cheap to re-emit.

Access goes through `@uptimizr/db` (`upsertSceneProxy`, `getSceneRepresentation`,
`listSceneRepresentations`) and is surfaced by the collector behind the project API key:

- `PUT /api/v1/scenes/:sceneId/representation` — body `{ proxy, label? }`; the server rejects a
  mismatch between the path `sceneId` and `proxy.sceneId` (`400`).
- `GET /api/v1/scenes/:sceneId/representation` — `404` when unregistered.
- `GET /api/v1/scene-representations` — summary list (omits the proxy blob).

### 2. The scene-proxy wire format (versioned Zod contract)

The proxy is a contract shared by an SDK producer and dashboard consumer, so — per the repo's
"events live once in `@uptimizr/schema`" rule — it is defined **once** as a Zod schema
(`sceneProxySchema`) and imported everywhere; never redefined.

- Carries a `version` literal (`SCENE_PROXY_VERSION = 1`) so consumers can gate on shape.
- `kind` is a `z.literal("aabb")` for now; `hull`/`voxel` are reserved for later versions without
  reshaping the envelope.
- Geometry is **per-mesh world-space AABBs** — `aabb` is a 6-tuple
  `[minX, minY, minZ, maxX, maxY, maxZ]`. This is the cheapest proxy that still conveys floors,
  walls, and big props, and needs no UV/vertex access.
- Includes `upAxis`, `unitScale`, scene `bounds`, `meshCount`, `capturedAt`, `sdkVersion`, and a
  **`contentHash`** (FNV-1a over the sorted mesh names + AABBs). The hash lets a producer skip
  re-`PUT`ing an unchanged scene and lets a consumer cache.

`scanSceneProxy` (in `@uptimizr/babylon`) traverses the live Babylon scene graph, skips
Uptimizr's own overlay meshes (`uptimizr-` prefix), disabled and vertex-less meshes, computes
world AABBs, and validates the result with `sceneProxySchema` before returning it.

## Consequences

### Positive

- The dashboard 3D heatmap gains a recognizable backdrop (Tier 2) with KB-sized payloads and **no
  real-art egress** — a privacy/IP win over Tier 3.
- One source of truth for the proxy shape (Zod), validated at both the SDK boundary and the
  ingestion route.
- The `kind` enum + `version` literal leave room for hulls, voxelizations, and full assets without
  a breaking migration or a superseding ADR.
- Upsert-by-`(project, scene)` keeps the model trivial and the proxy always reflects the live
  scene.

### Negative / trade-offs

- AABBs are coarse: thin or concave geometry reads as a filled box. Acceptable for orientation;
  hull/voxel tiers can refine later.
- No version history — re-registering overwrites. If audit/rollback is ever needed it requires a
  follow-up migration.
- `contentHash` keys on mesh **names** + bounds; a scene that mutates geometry without changing
  names/bounds could under-detect a change. The dev can always force a re-`PUT`.

## Alternatives considered

- **Store proxies in ClickHouse with the events.** Rejected — representations are low-volume,
  mutable, per-project **metadata**; Postgres is the right store (ADR 0002) and avoids polluting
  the append-only event table.
- **Ship full geometry (Tier 3) instead of a proxy.** Deferred — highest storage cost, largest
  IP/security surface, and drifts from the live scene. The proxy covers the common "what am I
  looking at" need at a fraction of the cost.
- **Per-version history table.** Rejected for now as premature; the live scene is authoritative
  and the proxy is cheap to regenerate.
- **Redefine the proxy type per consumer.** Rejected — violates the single-source-of-truth rule;
  a shared Zod schema in `@uptimizr/schema` keeps the SDK and dashboard in lockstep.
