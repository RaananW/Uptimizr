import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { vec3Schema } from "../primitives.js";

/**
 * Guardian / boundary proximity (ADR 0048, issue #157) — the visitor's tracked
 * VR position **approached their configured guardian / play-space boundary**.
 * Frequent boundary contact is a strong room-scale comfort / frustration signal:
 * the physical space didn't fit the experience.
 *
 * Like `hover_dwell`/`compile_stall`, the connector accumulates this on the
 * client and emits **one bucketed event per approach** rather than a per-frame
 * stream — the count is implied by event frequency, not a running counter.
 *
 * Privacy (ADR 0003 / ADR 0048): the WebXR bounds-check ("is the tracked pose
 * within N cm of the boundary") happens **entirely on device**. Only the outcome
 * is ever sent — a coarse HMD `position` (voxel-binned like every other
 * world-space signal, ADR 0010) plus a `durationMs`. The boundary polygon, room
 * size, and raw sensor data are **never** captured or transmitted, so no new
 * opt-in flag is required. `position` reuses the existing promoted column, so no
 * database migration is needed.
 */
export const xrBoundaryProximitySchema = defineEvent("xr_boundary_proximity", {
  /**
   * Camera / HMD world position `[x, y, z]` at the moment of closest approach to
   * the boundary. Reuses the existing promoted `position` column and is
   * voxel-binned on ingestion like every other world-space signal — never the
   * boundary geometry itself.
   */
  position: vec3Schema,
  /** Milliseconds the visitor stayed within the "near boundary" zone. */
  durationMs: z.number().nonnegative(),
});

export type XrBoundaryProximityEvent = z.infer<typeof xrBoundaryProximitySchema>;
