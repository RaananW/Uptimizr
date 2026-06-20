import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { normalized2Schema, vec3Schema } from "../primitives.js";
import { inputSourceShape } from "./inputSource.js";

/**
 * Raw button transitions. `pointer_down` and `pointer_up` bracket every press,
 * letting consumers reconstruct press-and-hold duration, drag gestures, and
 * abandoned clicks (down with no up) — signal that a single `pointer_click`
 * cannot express. They share `pointer_click`'s payload (position + optional
 * raycast hit + button) plus the shared input-source vocabulary (ADR 0011).
 */
const pointerButtonPayload = {
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
} as const;

/** Pointer/button pressed down. */
export const pointerDownSchema = defineEvent("pointer_down", pointerButtonPayload);
export type PointerDownEvent = z.infer<typeof pointerDownSchema>;

/** Pointer/button released. */
export const pointerUpSchema = defineEvent("pointer_up", pointerButtonPayload);
export type PointerUpEvent = z.infer<typeof pointerUpSchema>;
