import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { vec3Schema } from "../primitives.js";
import { inputSourceShape } from "./inputSource.js";
import { LIMITS } from "../limits.js";

/**
 * Kinds of mesh interaction. New kinds can be appended without a breaking change.
 * The `select`/`squeeze`/`grab`/`release`/`teleport` kinds map XR controller/hand
 * actions onto this source-neutral signal rather than into new event types
 * (ADR 0011).
 */
export const meshInteractionKindSchema = z.enum([
  "hover",
  "pick",
  "click",
  "drag",
  "select",
  "squeeze",
  "grab",
  "release",
  "teleport",
]);
export type MeshInteractionKind = z.infer<typeof meshInteractionKindSchema>;

/**
 * Interaction with a named mesh/object in the scene (hover, pick, click, ...).
 * Lets creators see which objects users actually engage with. This is the
 * primary source-neutral interaction signal: it carries the shared input-source
 * vocabulary (ADR 0011), so a mouse pick and an XR-controller select land in the
 * same signal, distinguished by `source`/`handedness`.
 */
export const meshInteractionSchema = defineEvent("mesh_interaction", {
  /** Name of the interacted mesh/object. */
  mesh: z.string().min(1).max(LIMITS.maxMeshNameLength),
  /** Interaction kind. */
  kind: meshInteractionKindSchema,
  /** World-space point of interaction, when available. */
  point: vec3Schema.optional(),
  ...inputSourceShape,
});
export type MeshInteractionEvent = z.infer<typeof meshInteractionSchema>;
