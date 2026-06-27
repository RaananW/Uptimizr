import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { vec3Schema } from "../primitives.js";

/**
 * Sampled camera pose. This is the backbone of the view-direction heatmap: where
 * the camera is and where it is looking over time. Sampling rate is an SDK option.
 *
 * The pose is replay-complete — position + forward direction (+ optional target and
 * fov) are enough to reconstruct the viewpoint in the user's own scene.
 */
export const cameraSampleSchema = defineEvent("camera_sample", {
  /** Camera world position `[x, y, z]`. */
  position: vec3Schema,
  /** Normalized forward/look direction `[x, y, z]`. */
  direction: vec3Schema,
  /** Look-at target in world space `[x, y, z]`, when applicable. */
  target: vec3Schema.optional(),
  /** Vertical field of view in radians, when applicable. */
  fov: z.number().optional(),
  /**
   * Viewport aspect ratio (width / height), when applicable. Together with `fov`
   * and `near` this lets flat-pointer click rays unproject a click's `screen[x,y]`
   * onto the camera near plane (issue #22). Absent unless the connector captures it.
   */
  aspect: z.number().positive().optional(),
  /**
   * Camera near-plane distance in world units, when applicable. Reconstructs the
   * near-plane origin for flat-pointer click-ray unprojection (issue #22). Absent
   * unless the connector captures it.
   */
  near: z.number().positive().optional(),
  /**
   * World-space point where the camera-forward (gaze) ray hits scene geometry,
   * when gaze raycasting is enabled (ADR 0030). This is the "what did people
   * actually look at" surface signal — a first-class world-space gaze heatmap,
   * distinct from the abstract direction sphere. **Opt-in, off by default**
   * (privacy + cost, ADR 0003 / ADR 0012); absent unless the connector is
   * configured to capture gaze. Ingestion projects it into the same `hit_point`
   * column the pointer world heatmap uses, so no schema migration is needed.
   */
  hitPoint: vec3Schema.optional(),
  /** Name of the mesh the gaze ray hit, when gaze raycasting is enabled (ADR 0030). */
  hitMesh: z.string().optional(),
});
export type CameraSampleEvent = z.infer<typeof cameraSampleSchema>;
