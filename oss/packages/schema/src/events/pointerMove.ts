import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { normalized2Schema, vec3Schema } from "../primitives.js";
import { inputSourceShape } from "./inputSource.js";

/**
 * Reusable shape for pointer events. Captures the optional 2D screen position
 * (for screen heatmaps) plus an optional 3D raycast hit and the name of the hit
 * mesh (for in-scene heatmaps), and the shared input-source vocabulary (ADR
 * 0011). Shared by `pointer_move` and `pointer_click`.
 */
const pointerPayload = {
  /**
   * Screen-normalized pointer position `[x, y]` in `[0, 1]`, origin top-left.
   * Present for flat inputs (mouse/touch/stylus); absent for world-space/ray
   * sources (ADR 0011).
   */
  screen: normalized2Schema.optional(),
  /** World-space point where the pointer ray hit the scene, if any. */
  hitPoint: vec3Schema.optional(),
  /** Name of the mesh the pointer ray hit, if any. */
  hitMesh: z.string().optional(),
  ...inputSourceShape,
} as const;

/** Sampled pointer movement. Sampling/throttling is an SDK option. */
export const pointerMoveSchema = defineEvent("pointer_move", pointerPayload);
export type PointerMoveEvent = z.infer<typeof pointerMoveSchema>;
