# ADR 0027: Scene-actor transform capture for replay (moving objects)

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** RaananW, engineering

## Context

Session replay ([ADR 0006](./0006-session-replay.md)) re-drives a visitor's **own inputs** —
camera pose, pointer, picks — over the developer's scene. The schema is "replay-complete" for those
signals, but it records nothing about **other objects that move on their own**: an ambient NPC,
a moving door or elevator, a vehicle, a physics prop. Those are driven by the host app's animation
/ AI / physics loop, not by the visitor.

The walkable playground surfaced the gap concretely: the demo scene has a wandering character, but
the session replay does not show it move. There are two failure modes depending on where replay runs:

- **Abstract proxy scene** (dashboard, scene-proxy AABBs — [ADR 0014](./0014-scene-registry.md)):
  the actor was never represented, so it simply isn't there.
- **Developer's-own-scene replay:** the actor _does_ animate, but it is driven live by the app, so
  it is desynchronized from what the visitor actually saw (different spawn time, RNG, physics seed,
  frame timing). The replayed world no longer matches the recorded session.

Either way the recorded session has no memory of where the actor was, so replay cannot reproduce it.

### Forces

- **Replay-completeness is the contract.** ADR 0006 promises a session can be reconstructed. A scene
  with self-moving actors silently breaks that promise. To keep it, the actor motion the visitor saw
  must be _recorded_, not _re-simulated_.
- **Re-simulation is not generally viable.** Requiring every host app to make its animation/AI/
  physics deterministic (seeded RNG, fixed timestep, no network) pushes a heavy, fragile burden onto
  integrators and still drifts. Determinism is a fine _optimization_ a developer may choose, but it
  cannot be the platform's answer.
- **This is a continuous, sampleable channel — not a discrete event.** Object transforms over time
  are exactly the kind of signal [ADR 0012](./0012-sampling-and-fidelity.md) already governs (like
  camera/head/controller pose): sampling them changes _resolution, not correctness_. It must inherit
  the existing fidelity dial rather than invent new sampling rules.
- **Volume is the real cost, and it is unbounded by default.** Cost ≈ `tracked nodes × sample rate`.
  Sampling an entire scene graph at `"frame"` would fill the store instantly — the precise warning in
  ADR 0012. The channel must be **opt-in with an explicit allowlist**, never "track everything."
- **Events live once.** Per [AGENTS.md](../../AGENTS.md), this is a new first-class event in
  `@uptimizr/schema`; it must not be smuggled into `camera_sample` or a `custom` payload.
- **Connector cost is modest; storage/privacy is the gate.** Reading a handful of node world-matrices
  per tick is cheap on the SDK side. The reason to keep this opt-in is **cost and privacy**, only
  secondarily client performance.
- **A skinned model is one node plus a skeleton, not one moving mesh.** Industry-standard rigged
  characters (Mixamo, glTF skins, ReadyPlayerMe) are a **single skinned mesh whose vertices are
  deformed on the GPU by a bone hierarchy**. The mesh node itself only carries the model's _root_
  transform (where the character stands / faces); a waving hand or a grab lives entirely in the
  **bones**, which the mesh transform never reflects. So "track the character" splits into two very
  different signals — cheap root locomotion vs. expensive per-bone articulation — and the ADR must
  address both explicitly rather than pretend a mesh transform captures a wave.
- **Engine node identity is unstable and not a good wire key.** Engine-assigned names collide and
  drift (Babylon auto-suffixes clones; glTF import names repeat; bone names vary by exporter). The
  capture key must be a **developer-declared id**, mapped to an engine node through an explicit
  contract the developer controls — this is also what makes the allowlist a real privacy/cost gate.
- **Privacy: usually low-PII, sometimes not.** Static-prop transforms carry little personal data, but
  if the tracked actors are _other visitors' avatars_ (multiplayer/social scenes), their motion —
  **especially full-body bone articulation (gait, height, tremor)** — is personal, biometric-adjacent
  data and re-enters [ADR 0003](./0003-privacy-model.md) / [ADR 0012](./0012-sampling-and-fidelity.md)
  §5 territory.

## Decision

Add an **opt-in, allowlisted, fidelity-dialed channel that records the transforms of named scene
actors** so replay can re-apply (not re-simulate) their motion. The channel has **two tiers** — a
cheap node/root tier and an opt-in skeleton/bone tier — that share one schema event but are
configured and gated separately.

1. **One new event type `node_transform` in `@uptimizr/schema`** ("events live once"). A
   first-class, **continuous / sampleable** event (never discrete; the SDK MAY thin it per the dial).
   Replay-complete payload per sample:
   - `nodeId` — the developer-declared id (see §6), **not** the engine's internal name.
   - `boneId` — **optional**; absent for the node/root tier, present for a skeleton bone. When
     present, `nodeId` identifies the owning skinned node and `boneId` the bone within its skeleton.
   - the transform — `position`, `rotation` (quaternion), and `scale` (only when it changes from
     identity / last sample).

   Node-tier transforms are in the canonical **world** frame
   ([ADR 0018](./0018-coordinate-frame-and-connector-provenance.md)). Bone-tier transforms are
   **local to the skeleton/parent bone** (the only frame that is portable across differing world
   placements of the same rig); replay composes them onto the live skeleton.

2. **Tier 1 — node/root transforms (the common case).** Tracks a node's own transform: locomotion and
   heading of an NPC, a sliding door, an elevator, a vehicle. One stream per actor, cheap. For a
   skinned character this is the **base mesh / root** and is usually all a walkable scene needs.

3. **Tier 2 — skeleton/bone transforms (opt-in, higher cost & privacy).** Tracks named bones of a
   rigged node so replay can reproduce articulation (a wave, a grab, a head turn). A humanoid rig is
   ~50–65 bones, so full-body per-frame capture is the system's heaviest signal — it is therefore
   **per-bone allowlisted**, never whole-skeleton-by-default, and inherits the avatar privacy gate.
   Bone replay **requires the same rig to exist in the target scene** (true for replay-in-own-scene);
   in the abstract proxy scene bones are skipped and only the Tier-1 root marker is shown.

4. **Default OFF, explicit allowlist at both tiers — never "track everything."** The developer names
   the nodes (Tier 1) and the specific bones (Tier 2) worth replaying; everything else is never
   sampled. There is no "track all nodes" or "track all bones" switch (a `"*"` bone include is
   permitted but documented as an explicit, expensive opt-in).

5. **Reuse the ADR 0012 sampling contract, per node and per bone-set.** Configuration lives under the
   existing `sampling` profile, honoring the same vocabulary (`0`/off, `N` Hz, `"frame"`), the same
   conservative defaults (~1 Hz), the same uncapped OSS ceiling (hosted MAY cap), and the same
   `suppressIdleSamples` win — a static actor or an unmoving bone emits nothing.

   ```ts
   trackScene({
     // §6: declare the developer-id → engine-node mapping once.
     actors: {
       "npc-guard": () => scene.getMeshByName("Guard_root"), // resolver fn (preferred)
       elevator: "Elevator.001", // or an engine name/id string
       "showroom-door": doorMeshRef, // or a direct engine ref
     },
     sampling: {
       nodes: {
         "npc-guard": 10, // Hz — Tier 1 root/locomotion
         elevator: "frame",
         // unlisted actors: not tracked
       },
       bones: {
         // Tier 2 — opt-in, references a declared actor
         "npc-guard": { include: ["mixamorig:RightHand", "mixamorig:LeftHand"], hz: 30 },
         // include: "*" => full rig (explicitly expensive); omit => no bone capture
       },
     },
   });
   ```

6. **Explicit developer mapping: `actors` declares developer-id → engine-node.** The developer
   provides a single `actors` map from each stable `nodeId` to the engine node, accepting any of:
   a **resolver function** `() => EngineNode | null` (preferred — robust to load order and clones),
   an **engine name/id string** the connector looks up, or a **direct engine object reference**. The
   connector resolves each entry once at capture start (re-resolving lazily if it returns null),
   reads world matrices for Tier 1 and, for Tier 2, walks the resolved node's skeleton to find the
   allowlisted bones by name. `sampling.nodes` / `sampling.bones` keys MUST reference ids declared in
   `actors`; an unknown id is a no-op with a dev-mode warning. This keeps the **wire key stable and
   developer-owned** while the engine-specific lookup stays in the connector.

   **`actors` is engine-typed and lives in each connector — not in `sdk-core`.** There is no single
   shared `trackScene`: every connector already ships its own with engine-specific positional args
   (`@uptimizr/babylon` `trackScene(scene, options)`, `@uptimizr/three`
   `trackScene(scene, camera, renderer, options)`, `@uptimizr/playcanvas` `trackScene(app, camera,
options)`, …) and its **own `TrackSceneOptions` interface**. `actors` is added to _each_
   connector's `TrackSceneOptions`, and the **value type is the engine's node type**: a Babylon
   resolver returns `AbstractMesh | TransformNode | null` (`scene.getMeshByName(…)`), a three resolver
   returns `Object3D | null` (`scene.getObjectByName(…)`), a PlayCanvas resolver returns
   `Entity | null` (`app.root.findByName(…)`). Same concept, engine-typed value — exactly like the
   existing `scene`/`camera`/`renderer` args already differ.

   **The connector owns the conversion to the engine-agnostic event.** Only the developer-declared
   `nodeId`/`boneId` and the plain numeric transform cross the boundary: the connector reads the
   engine node's world matrix, converts to the canonical world frame
   ([ADR 0018](./0018-coordinate-frame-and-connector-provenance.md)), walks the skeleton for Tier-2
   bones, and emits a `node_transform` whose payload is pure numbers. Nothing engine-specific reaches
   `sdk-core`, `@uptimizr/schema`, the collector, or `@uptimizr/replay` — identical to how Babylon
   picks become `mesh_interaction` and three raycasts become `pointer_click` today. New connectors
   implement the same `actors` → `node_transform` mapping per the `add-connector` workflow.

7. **Trackable node types — an explicit, normative allowlist.** The mechanism is "any node that
   exposes a world transform," but _what may be tracked_ is a closed list that connectors MUST honor
   and the integration docs MUST publish verbatim. This table is part of the public contract, not an
   implementation detail:

   | Category                                       | Examples                                                                                   | Status                           | Notes                                                                                                                                |
   | ---------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
   | **Meshes / skinned-mesh root**                 | NPC body, door, vehicle shell, prop                                                        | **In scope (Tier 1)**            | The common case; root transform = locomotion/heading.                                                                                |
   | **Transform-only nodes / groups / pivots**     | `TransformNode`, three `Object3D`/`Group`, empties, attachment sockets, a vehicle rig root | **In scope (Tier 1)**            | Often the _preferred_ target: one stream drives a whole parented assembly. No geometry needed.                                       |
   | **Skeleton bones**                             | `mixamorig:RightHand`, head bone                                                           | **In scope (Tier 2, opt-in)**    | Per-bone allowlist; skeleton-local; needs matching rig in target scene.                                                              |
   | **Moving lights**                              | swinging lamp, flashlight/headlamp, patrolling spotlight, sun                              | **Allowed, default OFF**         | Visually meaningful when they move; static lights are pointless. Replay only matches if the target scene has the same light.         |
   | **Non-active cameras**                         | security-monitor feed, scripted cutscene camera                                            | **Allowed, default OFF (niche)** | Track its parent transform; rarely worth it.                                                                                         |
   | **The active / visitor camera**                | the camera the visitor is looking through                                                  | **Excluded**                     | Already captured as `camera_sample`; re-recording it violates "events live once." Connectors MUST refuse it.                         |
   | **Particle systems**                           | fire, smoke, sparks                                                                        | **Out of scope**                 | GPU/simulation-driven, no per-node transform — would need a seed/emitter-state channel.                                              |
   | **Morph targets / blend shapes**               | facial animation, lip-sync, visemes                                                        | **Out of scope**                 | Driven by weight scalars, not a transform — a different payload entirely.                                                            |
   | **Instanced meshes / thin-instances / crowds** | a crowd of 500 instances under one node                                                    | **Out of scope (v1 non-goal)**   | N transforms inside one node; needs an `instanceId` dimension and has extreme volume. Noted as a future extension, not covered here. |

   Connectors enforce this list: the active camera is rejected with a dev-mode warning, and
   particle/morph/instance targets are rejected (they cannot produce a single `node_transform`). The
   list is intentionally conservative; new categories are added by superseding this ADR, not silently.

8. **Replay interpolates per actor and per bone.** `@uptimizr/replay` re-applies each tracked node's
   recorded transform over time (interpolating between samples), driving the matching node by
   `nodeId` and, when bone samples exist, the matching bone by `boneId` on the live skeleton. Unknown
   `nodeId`/`boneId` are skipped without error (forward/back-compatible). In the abstract proxy scene,
   a tracked actor MAY be drawn as a labeled proxy marker (Tier-1 root only).

9. **Storage: a dedicated `node_samples` table, not the wide `events` table.** The schema event stays
   unified (one `node_transform` type — SDK, connector, and validation are identical to every other
   channel); only **storage** splits. `node_transform` is the highest-cardinality signal in the
   system (actors × rate, × bones for Tier 2), so it gets its own transform-shaped table
   (`project_id`, `session_id`, `ts`, `node_id`, `bone_id`, `pos[3]`, `rot[4]`, `scale[3]`) instead
   of bloating the table every analytics query and per-session scan already hits, and instead of
   padding `events` with quaternion/bone columns that are null for all other types. On the ClickHouse
   scale store ([ADR 0020](./0020-open-core-storage-boundary.md)) it is ordered by
   `(project, session, node_id, ts)` for tight columnar compression and cheap per-actor reads. Replay
   **merges the two ordered streams by `ts`** (events + node_samples) — both written under the same
   per-session retention gate ([ADR 0003](./0003-privacy-model.md)) so they stay consistent.

10. **Privacy follows the actor's nature and tier.** Tier-1 prop/environment transforms are low-PII
    scene telemetry. Tier-2 bone capture of nodes that represent **people** (avatars) is treated like
    head/hand pose: the same pose-retention opt-in and rounding controls apply (ADR 0003 / ADR 0012
    §5), and per-frame avatar bone capture is opt-in, never a default.

11. **Scope: a Phase 1 OSS feature, delivered incrementally behind its own issues.** Replay runs on
    the OSS collector, so this is public-release (Phase 1) work, not hosted-only. It crosses schema,
    SDK-core, every connector, replay, and storage, so it ships in stages tracked as separate issues:
    the schema event + storage first, then the Babylon connector (Tier 1), then replay drive-back,
    then the remaining connectors, with Tier 2 (skeleton/bone) following Tier 1. A connector without
    the channel simply omits it.

## Consequences

### Positive

- Replay finally reproduces self-moving actors deterministically, restoring replay-completeness for
  scenes that are more than a static model plus a visitor.
- The node/bone split matches how rigged characters actually work industry-wide: cheap locomotion by
  default, full articulation only when the developer asks and pays for it.
- No new sampling/cost machinery — the channel rides the existing ADR 0012 dial, so operators reason
  about it with tools they already have.
- The dedicated `node_samples` table keeps the hot `events` table lean and gives the firehose a
  transform-shaped, well-compressing layout with cheap per-actor reads.
- Connector-agnostic (canonical world frame for nodes; skeleton-local for bones) and
  forward-compatible (unmatched `nodeId`/`boneId` are skipped).
- The explicit `actors` map keeps the wire key stable and developer-owned while engine-specific
  lookup (clones, load order, skeleton walking) stays contained in the connector.

### Negative / trade-offs

- Another continuous channel multiplies ingest/storage volume; mitigated by default-off, the
  allowlist, idle suppression, and conservative rates — but a careless `"frame"` node allowlist, and
  especially a `"*"` full-rig bone include, is a real footgun (documented as such).
- A second storage table means two insert paths and two parity fixtures, and replay must **merge two
  ordered streams by `ts`** instead of one scan — contained, but real, work.
- Bone replay assumes the **same rig** exists in the target scene; a mismatched/retargeted skeleton
  degrades to "skip bones, keep root" rather than erroring.
- Integrators must declare and maintain the `actors` map and keep allowlists in sync with their
  scene; renamed/removed actors degrade gracefully but silently.
- Avatar bone tracking introduces a biometric-adjacent privacy surface that must be consciously gated.

## Alternatives considered

- **Re-simulation via enforced determinism** — record nothing; require the host app to reproduce
  actor motion from a seed. Cheapest storage, but fragile across physics/AI/network and shifts the
  burden onto every integrator. Kept only as an optional developer-side optimization, not the
  platform answer.
- **Track the entire scene graph / whole skeleton automatically** — zero integration effort, but
  unbounded cost and a broad (biometric) privacy surface; violates the ADR 0012 "no track-everything
  default" stance.
- **Auto-use the engine's node/bone names as the wire key** — no developer mapping needed, but engine
  names collide and drift (clones, exporters), breaking replay matching and weakening the allowlist
  as a privacy gate. Rejected in favor of the explicit `actors` map.
- **Store `node_transform` in the shared `events` table** — reuses one ordered stream (no replay
  merge) and existing `position`/`rotation` columns, but bloats the highest-traffic table with the
  highest-cardinality event and pads every other event type with null bone/quaternion columns.
  Rejected for the dedicated table; the unified _schema_ event preserves "events live once."
- **Fold transforms into `camera_sample` or `custom`** — rejected: violates "events live once" and
  would make the channel un-sampleable/un-queryable as its own dimension.
- **Record per-actor animation-state names instead of transforms** — smaller payloads, but assumes
  the same animation rig/state machine exists and is deterministic in the target scene; far less
  general than raw transforms. Could be a future complementary channel, not the baseline.
