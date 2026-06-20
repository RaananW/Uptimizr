import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { vec3Schema, quatSchema } from "../primitives.js";
import { LIMITS } from "../limits.js";

/**
 * Sampled world transform of a developer-named scene actor (ADR 0027). Lets replay
 * **reproduce** (not re-simulate) objects that move on their own — an ambient NPC,
 * a door, an elevator, a vehicle — which the visitor's own input stream never
 * captures.
 *
 * Two tiers share this one event:
 * - **Tier 1 (node/root):** `boneId` absent. `nodeId` is the developer-declared id
 *   of an engine node; the transform is its world pose (locomotion/heading). A
 *   Tier-1 **subtree child** (ADR 0033) additionally carries `childPath` — the
 *   descendant's engine node path relative to `nodeId` — and stays in world frame.
 * - **Tier 2 (skeleton/bone):** `boneId` present. `nodeId` identifies the owning
 *   skinned node and `boneId` the bone within its skeleton; the transform is
 *   **local to the skeleton/parent bone** so it stays portable across differing
 *   world placements of the same rig.
 *
 * `boneId` and `childPath` are mutually exclusive on a sample.
 *
 * `nodeId`/`boneId` are developer-owned wire keys, never the engine's internal
 * names — the connector maps engine nodes to these ids (ADR 0027 §6). The pose is
 * replay-complete: position + rotation (+ scale when it changes) reconstruct the
 * actor's motion in the user's own scene.
 */
export const nodeTransformSchema = defineEvent("node_transform", {
  /** Developer-declared actor id (Tier 1 = the node; Tier 2 = the bone's owning node). */
  nodeId: z.string().min(1).max(LIMITS.maxNodeIdLength),
  /** Skeleton bone name — present only for Tier-2 (skeleton/bone) samples. */
  boneId: z.string().min(1).max(LIMITS.maxBoneIdLength).optional(),
  /**
   * Engine node path of a Tier-1 subtree child relative to `nodeId` (ADR 0033),
   * e.g. `"Body/Arm_L/Hand"`. Present only for subtree-child samples; world-frame
   * like any Tier-1 sample. Mutually exclusive with `boneId`.
   */
  childPath: z.string().min(1).max(LIMITS.maxChildPathLength).optional(),
  /** Position: world-space for Tier 1, skeleton-local for Tier 2 — `[x, y, z]`. */
  position: vec3Schema,
  /** Rotation quaternion `[x, y, z, w]` (same frame as `position`). */
  rotation: quatSchema,
  /** Scale `[x, y, z]`. Omitted when it has not changed from the last sample / identity. */
  scale: vec3Schema.optional(),
});
export type NodeTransformEvent = z.infer<typeof nodeTransformSchema>;
