import { z } from "zod";

/**
 * World coordinate-frame primitives shared by `session_start` (connector
 * provenance) and the scene proxy.
 *
 * NOTE: this `handedness` is the **coordinate-system** handedness of a 3D engine's
 * world space — distinct from the XR controller `handedness` on interaction events
 * (ADR 0011), which describes which hand holds a controller.
 *
 * Per ADR 0018, world-space payloads on the wire are always in the canonical frame
 * (left-handed, y-up, unit scale 1 — Babylon-native). A connector whose engine uses
 * a different native frame normalizes to canonical at the emission boundary, and
 * records its native frame here as provenance.
 */

/**
 * Handedness of an engine's world coordinate system. Babylon is left-handed;
 * three.js / glTF / PlayCanvas are right-handed.
 */
export const coordinateHandednessSchema = z.enum(["left", "right"]);
export type CoordinateHandedness = z.infer<typeof coordinateHandednessSchema>;

/** Which axis points "up" in world space. Most web engines are y-up; some pipelines z-up. */
export const upAxisSchema = z.enum(["y", "z"]);
export type UpAxis = z.infer<typeof upAxisSchema>;

/**
 * Compact description of a source engine's **native** world coordinate frame.
 * All fields are `passthrough`-friendly so adapters can add hints without a
 * breaking change.
 */
export const coordinateSystemSchema = z
  .object({
    /** Coordinate-system handedness of the source engine's world space. */
    handedness: coordinateHandednessSchema,
    /** Up axis of the source engine's world space. Defaults to `"y"`. */
    upAxis: upAxisSchema.default("y"),
    /** World units per meter in the source scene, if known. Defaults to `1`. */
    unitScale: z.number().positive().default(1),
  })
  .passthrough();
export type CoordinateSystem = z.infer<typeof coordinateSystemSchema>;
