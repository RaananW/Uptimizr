import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { aabbSchema } from "../sceneProxy.js";
import { LIMITS } from "../limits.js";

/**
 * Per-object attention / dwell summary (#37, design §A) — the 3D analog of
 * scroll-depth + time-on-element, and the metric configurator / e-commerce /
 * architecture users ask for most.
 *
 * Frustum visibility and occlusion are per-frame client work the server cannot
 * cheaply reconstruct, so the connector measures them on the client and emits
 * **one bucketed summary per object per window** (ADR 0012) rather than a
 * per-frame stream. Screen fraction uses the scene-proxy AABBs (ADR 0014).
 *
 * Privacy (ADR 0003): `mesh` is a low-cardinality, app-defined object name; the
 * durations and fractions are coarse aggregates, never per-frame traces. The
 * signal is opt-in.
 */
export const meshVisibilitySchema = defineEvent("mesh_visibility", {
  /** Name of the mesh/object this summary is for. */
  mesh: z.string().min(1).max(LIMITS.maxMeshNameLength),
  /** Milliseconds the object was on-screen (in-frustum, un-occluded) during the window. */
  visibleMs: z.number().nonnegative(),
  /**
   * Milliseconds the object was near screen-center during the window — an
   * eye-tracking-free "looked at" proxy (gaze ≈ where the camera points).
   */
  centeredMs: z.number().nonnegative().optional(),
  /**
   * Largest fraction of the viewport the object covered during the window
   * (`0`–`1`), a prominence proxy derived from the scene-proxy AABB.
   */
  maxScreenFraction: z.number().min(0).max(1).optional(),
  /**
   * Optional world-space axis-aligned bounding box of the object at the time it
   * was seen, encoded `[minX, minY, minZ, maxX, maxY, maxZ]` (the scene-proxy
   * {@link aabbSchema} convention, ADR 0014; coordinate frame per ADR 0018).
   *
   * Opt-in ride-along (#53): when the connector is configured to attach bounds,
   * the dashboard can render a coarse "ghost" reconstruction of the scene — one
   * box per observed object — and lay dwell heat on it without the host's real
   * geometry. Sent once per object (or on meaningful change), not every window,
   * since bounds are near-static. Absent unless explicitly enabled.
   */
  bounds: aabbSchema.optional(),
});
export type MeshVisibilityEvent = z.infer<typeof meshVisibilitySchema>;
