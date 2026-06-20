import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { normalized2Schema, vec3Schema } from "../primitives.js";
import { inputSourceShape } from "./inputSource.js";

/**
 * Pointer click / tap. Like `pointer_move` but additionally records which button
 * was pressed. Drives the click heatmap. Carries the shared input-source
 * vocabulary (ADR 0011).
 */
export const pointerClickSchema = defineEvent("pointer_click", {
  /**
   * Screen-normalized pointer position `[x, y]` in `[0, 1]`, origin top-left.
   * Present for flat inputs; absent for world-space/ray sources.
   */
  screen: normalized2Schema.optional(),
  /** World-space point where the pointer ray hit the scene, if any. */
  hitPoint: vec3Schema.optional(),
  /** Name of the mesh the pointer ray hit, if any. */
  hitMesh: z.string().optional(),
  /** Mouse/pointer button: 0 = primary, 1 = middle, 2 = secondary. */
  button: z.number().int().min(0).optional(),
  ...inputSourceShape,
});
export type PointerClickEvent = z.infer<typeof pointerClickSchema>;
