import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { vec3Schema } from "../primitives.js";
import { LIMITS } from "../limits.js";

/**
 * Coarse classification of the real-world surface an AR model was placed on
 * (ADR 0048 §1). Deliberately tiny and on-device-derived: WebXR hit-test /
 * plane-detection reports a plane orientation and rough semantic label, which a
 * connector maps onto this fixed set. It never carries raw plane geometry or
 * room dimensions — only the coarse bucket — so it stays inside ADR 0003's
 * default privacy posture.
 *
 * - `floor`   — a horizontal plane at/below standing height.
 * - `wall`    — a vertical plane.
 * - `table`   — a horizontal plane at roughly table/desk height.
 * - `ceiling` — a horizontal plane above head height.
 * - `unknown` — the connector could not classify the surface.
 */
export const arPlacementSurfaceSchema = z.enum(["floor", "wall", "table", "ceiling", "unknown"]);

export type ArPlacementSurface = z.infer<typeof arPlacementSurfaceSchema>;

/**
 * AR object-placement "settle" (#156, ADR 0048 §1). The AR equivalent of an
 * add-to-cart signal for retail "view in your room" experiences: a discrete,
 * source-neutral lifecycle event emitted **once per placement settle** (not per
 * frame) once the visitor stops moving/scaling the model and commits it to a
 * surface.
 *
 * It answers the placement-friction questions that are otherwise invisible: how
 * long placement took, how many times the visitor re-placed/re-scaled before
 * settling, what surface the model landed on, and the final scale relative to
 * the model's authored real-world size.
 *
 * Storage (ADR 0048): reuses the existing promoted `mesh` and `position`
 * columns; every other field rides in the JSON `payload` (like
 * `compile_stall`/`asset_load`'s non-hot fields), so **no database migration**
 * is required.
 *
 * Privacy (ADR 0003): carries only a coarse surface bucket and on-device-derived
 * counts/durations — no room geometry, no plane polygons, no PII. World position
 * is voxel-binned downstream like every other spatial signal (ADR 0010).
 */
export const arPlacementSchema = defineEvent("ar_placement", {
  /** Name of the placed model/asset (existing promoted column). */
  mesh: z.string().min(1).max(LIMITS.maxMeshNameLength),
  /** Final world position of the settled model (existing promoted column). */
  position: vec3Schema,
  /** Coarse surface the model settled on, when the connector can classify it. */
  surface: arPlacementSurfaceSchema.optional(),
  /**
   * Number of place/re-place actions the visitor made before this settle
   * (`1` = placed once and committed). Re-placement count is the AR analogue of
   * cart hesitation.
   */
  attempts: z.number().int().positive(),
  /**
   * Milliseconds from AR session start (or entering placement mode) to this
   * settle — the felt time-to-place.
   */
  timeToPlaceMs: z.number().nonnegative(),
  /**
   * Final scale relative to the model's authored real-world size (`1` = actual
   * size). Values <1 mean the visitor shrank it, >1 mean they enlarged it.
   */
  scale: z.number().positive(),
  /**
   * Whether this is the last placement recorded for the session, so a
   * funnel/conversion query doesn't have to guess which settle was final.
   */
  final: z.boolean(),
});

export type ArPlacementEvent = z.infer<typeof arPlacementSchema>;
