import { z } from "zod";
import { vec3Schema } from "../primitives.js";

/**
 * The input source behind an interaction (ADR 0011, extended by ADR 0023).
 * Low-cardinality and source-agnostic: mirrors WebXR target-ray modes
 * (`xr-controller`, `hand`, `gaze`, `transient`) alongside the common flat
 * inputs, plus the discrete devices `keyboard` and `gamepad` (ADR 0023). New
 * kinds can be appended without a breaking change.
 *
 * Absence on an event means `"mouse"` (the historical default; realized at
 * storage), so existing events and SDK call sites stay valid.
 */
export const inputSourceSchema = z.enum([
  "mouse",
  "touch",
  "stylus",
  "pen",
  "keyboard",
  "gamepad",
  "xr-controller",
  "hand",
  "gaze",
  "transient",
  "other",
]);
export type InputSource = z.infer<typeof inputSourceSchema>;

/**
 * Which of a paired set of sources produced the interaction (the two XR
 * controllers/hands). Absent ⇒ not applicable (e.g. mouse, gaze).
 */
export const handednessSchema = z.enum(["left", "right", "none"]);
export type Handedness = z.infer<typeof handednessSchema>;

/**
 * A world-space pointing ray: where the user pointed *from* and in which
 * direction. `hitPoint`/`point` capture the ray *result* on geometry (what
 * heatmaps consume); `ray` captures the origin, which replay and
 * "pointing-origin" analytics need. Natively produced by XR controllers/hands
 * and gaze.
 */
export const raySchema = z.object({
  /** Ray origin in world space. */
  origin: vec3Schema,
  /** Normalized ray direction in world space. */
  direction: vec3Schema,
});
export type Ray = z.infer<typeof raySchema>;

/**
 * Shared, optional source-describing fields spread into every interaction event
 * (ADR 0011). All optional and additive so existing producers/consumers are
 * unaffected; `source` absent ⇒ `"mouse"`.
 */
export const inputSourceShape = {
  /** The input source. Absent ⇒ `"mouse"`. */
  source: inputSourceSchema.optional(),
  /** Handedness for paired XR sources. Absent ⇒ not applicable. */
  handedness: handednessSchema.optional(),
  /**
   * Ephemeral, **session-local, non-persistent** id correlating a concurrent
   * stream (e.g. bracketing a `pointer_down`→`pointer_up` pair to the same
   * source when several are active). MUST NOT be a stable device/user id
   * (ADR 0003) — it is a disambiguator only.
   */
  sourceId: z.string().min(1).max(64).optional(),
  /** World-space pointing ray, for sources that are natively rays. */
  ray: raySchema.optional(),
} as const;
