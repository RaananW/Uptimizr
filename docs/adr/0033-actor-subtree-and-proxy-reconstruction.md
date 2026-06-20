# ADR 0033: Actor subtree capture and proxy-driven replay reconstruction

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** RaananW, engineering
- **Amends:** [ADR 0027](./0027-scene-actor-transform-capture.md) §1 (event payload), §4 (the
  absolute "no track-all-nodes" rule), §8 (replay), §9 (storage). ADR 0027's two-tier model,
  `actors` mapping, fidelity dial, privacy gates, and trackable-type allowlist remain in force.

## Context

ADR 0027 records the transforms of **named scene actors** so replay can re-apply (not re-simulate)
their motion. Its Tier 1 (node/root) capture deliberately tracks **one declared node per stream**
and §4 forbids any "track all nodes" switch (a `"*"` include is permitted only for Tier 2 bones).

That decision is correct for a single mesh, a door, or an elevator. It becomes hostile DX for the
case integrators actually hit most: **a loaded glTF (or `.glb`) is a deep hierarchy of internal
nodes.** A vehicle, a machine, a rigged-by-transform-nodes prop, or a multi-part assembly can be
dozens to hundreds of `TransformNode`/`Object3D`/`Entity` nodes under one import root. Two failure
modes follow from ADR 0027 as written:

- **Manual enumeration is infeasible.** To replay a 120-node machine the developer must list all 120
  ids in `actors` **and** `sampling.nodes`, and keep that list in sync with every re-export. This is
  exactly the "wouldn't it be crazy to list every sub-node?" objection — and it is.
- **Tracking only the import root loses internal motion.** Declaring just the root captures one
  rigid frame. If the assembly's parts move **relative to** the root (a turning wheel, a swinging
  arm), the root stream cannot reproduce it; if they move **rigidly with** the root, the dashboard
  still draws a single marker at the root, not the assembly, because the abstract proxy scene
  ([ADR 0014](./0014-scene-registry.md)) has no parent→child reconstruction.

There are therefore **two distinct, composable needs**, and ADR 0027 addresses neither for a glTF:

1. **Rigid whole-assembly motion from one stream** — the parts don't move relative to the root
   (most props/vehicles-as-a-body). This should cost exactly one node stream and require **zero**
   sub-node listing; the sub-meshes ride along automatically.
2. **Internal articulation** — parts move relative to the root, but the rig is **transform nodes,
   not a skeleton**, so Tier 2 (bones) does not apply. This needs a **bounded** subtree capture, not
   a hand-written list.

### Forces

- **DX: one declaration per logical actor.** A developer should declare the glTF root once and get a
  replayable result, mirroring how Tier 2 already accepts `include: "*"` to capture a whole skeleton
  from a single declared skinned node. The asymmetry (bones may wildcard, nodes may not) is the bug.
- **Volume is still the gate (ADR 0012).** Cost ≈ `nodes × rate`. A naive subtree walk on a 1000-node
  scene at `"frame"` is the precise firehose ADR 0027 §4 guards against. Any wildcard MUST be
  **bounded** (depth, count) and **default OFF** — the relaxation is "a *bounded* subtree of a
  *declared* actor," never "the whole graph."
- **Replay-completeness (ADR 0006).** Whatever is captured must reconstruct deterministically.
  Rigid reconstruction from a root stream is exact **only when the parts are rigid w.r.t. the root**;
  the system must not silently fake internal motion it never recorded.
- **Events live once / engine-agnostic boundary.** Sub-nodes must cross the wire as developer-anchored
  numbers, not engine objects — identical to ADR 0027's `nodeId`/`boneId` contract.
- **Identity must stay developer-owned at the anchor.** ADR 0027 rejected raw engine names as wire
  keys because they collide/drift. A subtree's children are inherently engine-named — so they must be
  **scoped under a developer-declared root id**, exactly as `boneId` is scoped under `nodeId`.
- **The proxy already exists.** ADR 0014 registers a scene proxy. Reusing it to reconstruct a rigid
  sub-assembly under a moving root avoids capturing per-child transforms at all for the rigid case —
  the cheapest possible answer.

## Decision

Relax ADR 0027 §4 for Tier 1 with a **bounded** subtree capture, add a **proxy-driven rigid
reconstruction** path to replay, and extend the event/storage with a child-scoping field. Four
parts:

### 1. Tier 1 subtree capture — bounded `include`, anchored at a declared actor

`sampling.nodes[id]` MAY be either the existing scalar (`N` Hz / `"frame"` / `0`) **or** a config
object that opts into a subtree walk of the **already-declared** actor `id`:

```ts
trackScene({
  actors: { machine: () => scene.getObjectByName("Machine_root") }, // one declaration (ADR 0027 §6)
  sampling: {
    nodes: {
      machine: {
        hz: 20,
        include: "*",        // walk descendant transform nodes of `machine`
        maxDepth: 6,         // default 8 — hard depth cap from the anchor
        maxNodes: 64,        // default 64 — hard count cap (deterministic truncation)
        exclude: ["FX_*"],   // optional name globs skipped during the walk
      },
    },
  },
});
```

Rules (connectors MUST honor, integration docs MUST publish):

- **Anchored, never global.** `include` only ever walks descendants of a node **declared in
  `actors`**. There is still no way to say "track the whole scene." The allowlist gate of ADR 0027 §4
  is preserved at the *root*; the relaxation is strictly *within* a declared actor's subtree.
- **Bounded by construction.** `maxDepth` (default **8**) and `maxNodes` (default **64**) are hard
  caps. When the walk would exceed `maxNodes`, it stops at a **deterministic** order
  (breadth-first, then by child index) and emits a single dev-mode warning naming the dropped count —
  capture never silently balloons.
- **Transform nodes only.** The walk yields nodes that expose a world transform (meshes,
  groups/`TransformNode`/`Object3D`/`Entity`, pivots). It **skips skeleton bones** (Tier 2 governs
  those via `sampling.bones`, unchanged) and **refuses the active camera** (ADR 0027 §7). Particle/
  morph/instanced nodes remain out of scope.
- **`exclude` predicate.** An optional list of name globs pruned during the walk (whole subtrees
  pruned at a match), so FX/helper nodes don't consume the budget.
- **Default OFF, idle-suppressed.** Absent `include`, behavior is exactly ADR 0027 (single root
  stream). With `include`, unchanged child nodes still emit nothing (`suppressIdleSamples`), so a
  static sub-assembly costs one root stream regardless of node count.

### 2. Event payload — add optional `childPath` (mirror of `boneId`)

Extend the `node_transform` schema event (ADR 0027 §1) with one optional field:

- `childPath` — **optional**; absent for the declared root and for bone samples. When present,
  `nodeId` identifies the **declared** actor and `childPath` is the engine node path of the descendant
  **relative to that actor root** (e.g. `"Body/Arm_L/Hand"`). Node-tier child transforms remain in
  the canonical **world** frame (ADR 0018), like any Tier 1 sample.

`childPath` is to a Tier 1 subtree what `boneId` is to a Tier 2 skeleton: the wire key stays
developer-owned at the anchor (`nodeId`), while descendants are addressed by a **stable relative
path** matched against the same glTF in the target scene. `boneId` and `childPath` are mutually
exclusive on a sample.

### 3. Replay — proxy-driven **rigid** reconstruction (no per-child capture)

Add a reconstruction path so the **rigid** case (need #1) costs a single root stream and **zero**
sub-node listing. When (a) an actor is captured Tier 1 root-only and (b) a scene proxy
([ADR 0014](./0014-scene-registry.md)) is registered for the scene, `@uptimizr/replay` MAY attach the
proxy sub-meshes whose proxy parent chain roots at that actor and move them **rigidly** with the
recorded root transform:

```
childWorld(t) = rootWorld(t) · rootWorld(t0)⁻¹ · childWorldAtScan
```

where `t0` is the actor's first recorded sample (or the scan time) and `childWorldAtScan` comes from
the proxy snapshot. This reconstructs a whole sub-assembly from one stream in the **abstract proxy
scene** (dashboard) — the "parenting just works" behavior — without capturing or listing any child.

- **Rigid only, and labeled as such.** This path reproduces motion that is rigid w.r.t. the root. It
  MUST NOT be used to fake internal articulation: if the developer needs parts moving relative to the
  root, they opt into subtree capture (part 1), and replay drives each captured `childPath` directly
  (interpolated per ADR 0027 §8). Replay prefers a **captured** `childPath` sample over the
  reconstructed transform whenever one exists.
- **Own-scene replay is unchanged** beyond honoring `childPath`: it resolves `nodeId` then the
  relative `childPath` against the live graph and applies the transform; unknown paths are skipped
  (forward/back-compatible, ADR 0027 §8).
- **Proxy must carry hierarchy + scan-time world transform.** ADR 0014's proxy snapshot is extended
  to record, per mesh, its parent linkage and world transform at scan time (enough to evaluate the
  formula). Proxies without this remain valid; reconstruction is simply unavailable for them
  (degrade to the single root marker).

### 4. Storage — add a nullable `child_path` column

`node_samples` (ADR 0027 §9) gains a nullable `child_path` column; the ClickHouse ordering key
becomes `(project, session, node_id, child_path, ts)` so a subtree's children compress and read
together. `bone_id` and `child_path` are never both set on a row. This is an additive,
forward-only migration ([ADR 0007](./0007-migrations.md)).

### Scope

Phase 1 OSS, delivered incrementally behind its own issues, in this order: schema `childPath` +
storage column; replay proxy-reconstruction (rigid, dashboard) — the highest-leverage, lowest-cost
win; then the Tier 1 subtree walk in the Babylon connector, then the remaining connectors. A
connector without subtree support simply ignores `include` and keeps single-root behavior.

## Consequences

### Positive

- A glTF becomes **one declaration**: track the import root and either get rigid whole-assembly
  replay for free (proxy reconstruction) or `include: "*"` a bounded subtree for internal motion — no
  sub-node enumeration, restoring symmetry with the Tier 2 `"*"` bone include.
- The cheapest case (rigid assembly) captures **one** stream and reconstructs the whole sub-assembly
  in the dashboard, directly answering the "parenting should just work" expectation.
- Caps (`maxDepth`/`maxNodes`/`exclude`) + default-OFF + idle suppression keep the ADR 0012 volume
  contract intact; the relaxation is bounded and anchored, not a track-everything switch.
- `childPath` reuses the proven `boneId` scoping pattern, so the wire key stays developer-owned and
  the engine-agnostic boundary is unchanged.

### Negative / trade-offs

- Proxy reconstruction is **rigid-only**; internal articulation still requires explicit subtree
  capture. The distinction must be documented or it will surprise integrators.
- ADR 0014's proxy format grows (per-mesh parent + scan-time world transform), and replay gains a
  reconstruction branch and a "captured child wins over reconstructed" precedence rule.
- A careless `include: "*"` with raised caps on a deep import is still a footgun; mitigated by
  conservative defaults and the truncation warning, but real.
- `childPath` relies on stable relative node paths across re-exports; a renamed intermediate node
  degrades to "skip that child" rather than erroring (consistent with ADR 0027's graceful-degradation
  stance).

## Alternatives considered

- **Leave ADR 0027 as-is; require enumerating sub-nodes.** Zero new machinery, but the DX is
  unacceptable for real glTFs — the motivating complaint. Rejected.
- **Unbounded automatic subtree/whole-graph capture.** Maximal convenience, but reintroduces exactly
  the unbounded-volume and broad-privacy surface ADR 0027 §4 forbids. Rejected in favor of bounded,
  anchored `include`.
- **Synthesize a flat `nodeId` per child (`"root/child"`).** Avoids a new field, but bakes engine
  child names into the top-level wire key — the collision/drift problem ADR 0027 rejected for roots.
  Rejected for the scoped `childPath` (engine name allowed only *under* a declared anchor).
- **Skip subtree capture; rely solely on proxy reconstruction.** Covers the rigid case elegantly but
  cannot reproduce parts moving relative to the root. Kept as the cheap default, not the whole answer.
- **Treat transform-node rigs as skeletons (reuse Tier 2).** Conflates two different engine concepts
  (skeletons need a matching rig and use skeleton-local frames); transform-node subtrees are plain
  world-frame nodes. Rejected — `childPath` stays Tier 1.
