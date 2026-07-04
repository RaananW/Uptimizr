import { z } from "zod";
import { vec3Schema } from "../primitives.js";
import { defineEvent } from "./defineEvent.js";

/**
 * Sampled rendering-performance snapshot. Emitted periodically (sampling rate is
 * an SDK option) to keep volume bounded while still characterizing perf.
 *
 * The windowed averages (`fps`, `frameTimeMs`) tell you the typical experience;
 * the percentile/jank fields (`frameTimeP95Ms`, `frameTimeP99Ms`, `longFrames`)
 * surface the stalls users actually feel, since smoothness is the worst 1% of
 * frames, not the mean (#41, design §C). The resolution fields (`dpr`,
 * `renderScale`) keep an FPS claim honest — "60 FPS" is hollow if it was reached
 * by rendering at half resolution (#43, design §C).
 */
export const framePerfSchema = defineEvent("frame_perf", {
  /** Frames per second over the sampling window. */
  fps: z.number().nonnegative(),
  /** Average frame time in milliseconds over the window. */
  frameTimeMs: z.number().nonnegative().optional(),
  /** 95th-percentile frame time (ms) over the window — the typical jank ceiling. */
  frameTimeP95Ms: z.number().nonnegative().optional(),
  /** 99th-percentile frame time (ms) over the window — the worst-felt stalls. */
  frameTimeP99Ms: z.number().nonnegative().optional(),
  /** Count of frames in the window whose frame time exceeded the SDK's jank threshold. */
  longFrames: z.number().int().nonnegative().optional(),
  /** Number of draw calls in the sampled frame, when available. */
  drawCalls: z.number().nonnegative().optional(),
  /** Device pixel ratio in effect for the window (`window.devicePixelRatio`). */
  dpr: z.number().positive().optional(),
  /** Engine render scale actually used (e.g. Babylon `hardwareScalingLevel` inverse); `1` = native. */
  renderScale: z.number().positive().optional(),
  /**
   * Camera world position `[x, y, z]` at the moment of this perf sample, when the
   * connector captures it (#145). Optional and backward-compatible: it lets FPS be
   * voxel-binned *spatially* ("FPS is bad in the boss room"), not only time-bucketed.
   * Populated by the connector from the same camera as `camera_sample`, so it needs
   * no separate stream and no nearest-in-time join. Stored in the already-promoted
   * generic `position` column — no migration.
   */
  position: vec3Schema.optional(),
});
export type FramePerfEvent = z.infer<typeof framePerfSchema>;
