---
title: Mesh & object tracking
description: Capture which meshes users interact with, look at, and hesitate over — plus scene actors that move on their own.
---

Uptimizr can attribute interaction and attention to the **objects** in your scene, not just to screen
coordinates. There are four distinct mechanisms, from always-on to fully opt-in.

## Mesh interactions (`mesh_interaction`) — on by default

Every click/tap that hits geometry emits a `mesh_interaction` carrying the mesh name and the world hit
point. This powers the **most-interacted meshes** view. It's on by default; disable with
`capture.meshPicks: false`.

Read it back via `GET /api/v1/meshes/top`:

```http
GET /api/v1/meshes/top?since=...&limit=20
x-api-key: your-project-api-key
```

:::caution
Mesh attribution relies on your meshes having **stable names**. Procedurally-generated or clone-suffixed
names (`Box.001`, `Box.002`, …) fragment the ranking. Give interactive meshes deliberate, stable names.
:::

## Object dwell (`meshVisibility`) — opt-in

How long was an object actually **on screen**, and how long did the viewer **look at** it? Off by
default for privacy. When enabled, the connector emits one **bucketed** `mesh_visibility`
summary per tracked object per window (never per frame):

```ts
trackScene(scene, {
  // ...
  meshVisibility: {
    windowMs: 5000, // one summary per object every 5 s (default)
    meshes: ["product-hero"], // allowlist; omit to track all visible meshes
    maxMeshes: 50, // cap when no allowlist is given (default)
    centeredAngleDeg: 12, // "looking at it" half-angle (default)
    boundingBox: true, // ride each object's world AABB along (off by default)
  },
});
```

Each summary carries `visibleMs` (time in view), `centeredMs` (time within `centeredAngleDeg` of the
camera-forward axis), and `maxScreenFraction` (peak apparent size, 0–1).

With `boundingBox: true`, a summary may also carry `bounds` — the object's world-space AABB
`[minX, minY, minZ, maxX, maxY, maxZ]`. It's sent **once per object** and re-sent only when it
moves/resizes, so the dashboard can render a coarse "ghost" of the scene (one box per object) and lay
dwell heat on it **without** your real geometry. Off by default: it discloses scene layout.

## Hover hesitation (`hover_dwell`) — opt-in

Where do pointer users **hover and hesitate** without clicking? High dwell with few interactions is the
"this looks interactive but isn't (obviously) clickable" signal. Off by default:

```ts
trackScene(scene, {
  // ...
  capture: { hoverDwell: true },
  hoverDwell: {
    minDwellMs: 500, // ignore pass-overs shorter than this (default)
    meshes: ["product-hero"], // allowlist; omit to track every hovered mesh
  },
});
```

One **bucketed** `hover_dwell` summary is emitted per hover _episode_ (never per frame). An episode ends
when the pointer moves to a different object (or off all geometry), and is **suppressed if the object
was clicked** during the hover — a click is an action, not hesitation. Each event carries `mesh`,
`dwellMs`, and the originating input `source`.

## Scene actors (`node_transform`) — opt-in

Replay re-drives the visitor's own inputs, but scenes often contain objects that move on their **own** —
an ambient NPC, a sliding door, an elevator, a vehicle, a rigged character's wave. Those are driven by
your animation/AI/physics loop, so by default the session has no memory of where they were. Opt in to
record them as `node_transform` events; [replay](/docs/guides/replay/) **re-applies** (does
not re-simulate) their motion.

Capture is **off by default** and **allowlisted** — there is no "track everything" switch. Declare a
stable `nodeId` → engine-node mapping once via `actors`, then dial each actor under `sampling`:

```ts
trackScene(scene, {
  // ...
  actors: {
    "npc-guard": () => scene.getMeshByName("Guard_root"), // resolver (preferred — robust to load order/clones)
    elevator: "Elevator.001", // engine name/id string
    "showroom-door": doorMeshRef, // direct engine ref
  },
  sampling: {
    // Tier 1 — node/root transform (world frame): locomotion + heading.
    nodes: {
      "npc-guard": 10, // Hz
      elevator: "frame",
    },
    // Tier 2 — skeleton bones (opt-in, skeleton-local; Babylon, three, PlayCanvas).
    bones: {
      "npc-guard": { include: ["mixamorig:RightHand", "mixamorig:LeftHand"], hz: 30 },
      // include: "*" => full rig (explicitly expensive); omit => no bone capture
    },
  },
});
```

`sampling.nodes` / `sampling.bones` keys MUST reference ids declared in `actors`; an unknown id is a
no-op with a dev-mode warning. Tier-1 transforms are sampled in the canonical **world** frame; Tier-2
bone transforms are **skeleton-local** (the only frame portable across differing world placements of the
same rig). Idle suppression applies — a static actor or unmoving bone emits nothing.

### Engine support

`actors` is engine-typed: the resolver returns that engine's node type — Babylon
`AbstractMesh | TransformNode | null`, three `Object3D | null`, PlayCanvas `Entity | null`. Tier-2 bone
capture works on Babylon, three (`SkinnedMesh.skeleton.bones`), and PlayCanvas
(`skinInstance.bones`). The `babylon-lite` connector supports **Tier 1 only** (no named-bone API).

### What may be tracked

The mechanism is "any node that exposes a world transform," but the trackable set is a closed,
normative list:

| Category                                   | Status                           | Notes                                                          |
| ------------------------------------------ | -------------------------------- | -------------------------------------------------------------- |
| Meshes / skinned-mesh root                 | In scope (Tier 1)                | The common case; root transform = locomotion/heading.          |
| Transform-only nodes / groups / pivots     | In scope (Tier 1)                | Often preferred — one stream drives a whole parented assembly. |
| Skeleton bones                             | In scope (Tier 2, opt-in)        | Per-bone allowlist; skeleton-local; needs matching rig.        |
| Moving lights                              | Allowed, default **OFF**         | Replay only matches if the target scene has the same light.    |
| Non-active cameras                         | Allowed, default **OFF** (niche) | Track its parent transform; rarely worth it.                   |
| The active / visitor camera                | **Excluded**                     | Already captured as `camera_sample`; connectors refuse it.     |
| Particle systems                           | Out of scope                     | GPU/simulation-driven, no per-node transform.                  |
| Morph targets / blend shapes               | Out of scope                     | Driven by weight scalars, not a transform.                     |
| Instanced meshes / thin-instances / crowds | Out of scope (v1)                | N transforms in one node; needs an `instanceId` dimension.     |

The active/visitor camera and particle/morph/instance targets are rejected with a dev-mode warning.

## See also

- [Performance & diagnostics](/docs/guides/performance/#world-space-gaze) — world-space **gaze**
  attributes attention to whatever geometry the camera-forward ray hits.
- [Session replay](/docs/guides/replay/) — re-drive recorded actors (`nodes` map / `onNodeTransform`).
