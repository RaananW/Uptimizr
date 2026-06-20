import { z } from "zod";
import { defineEvent } from "./defineEvent.js";

/**
 * GPU / memory footprint sample (#44, design §C). Where `session_start.device`
 * records the GPU *caps* once, this records the actual *cost over time*: how much
 * texture / geometry memory is resident, how many triangles / vertices the engine
 * is pushing, and how large the JS heap has grown. Sustained growth here is a
 * strong correlate of mobile crashes / abandonment — the device's caps say what
 * it *can* do; this says what the scene is *actually* asking of it.
 *
 * Sampling (ADR 0012): emitted on a **low-rate** timer, not per frame. Capture is
 * **opt-in, off by default** (ADR 0003) — it adds a recurring measurement and is
 * only worth it when you are chasing footprint/stability.
 *
 * Every field is optional: engines expose different subsets (e.g. three surfaces
 * rendered-triangle counts but not byte totals; `jsHeapBytes` is Chromium-only).
 * A connector emits whatever it can read cheaply and omits the rest. Privacy: all
 * fields are coarse numeric aggregates — no scene contents, no PII.
 */
export const resourceSampleSchema = defineEvent("resource_sample", {
  /** Resident texture memory in bytes, when the engine can report it. */
  textureBytes: z.number().nonnegative().optional(),
  /** Resident geometry (vertex/index buffer) memory in bytes, when reportable. */
  geometryBytes: z.number().nonnegative().optional(),
  /** Triangles submitted in the sampled frame. */
  triangles: z.number().int().nonnegative().optional(),
  /** Vertices submitted in the sampled frame. */
  vertices: z.number().int().nonnegative().optional(),
  /** Used JS heap in bytes (`performance.memory.usedJSHeapSize`; Chromium-only). */
  jsHeapBytes: z.number().nonnegative().optional(),
});

export type ResourceSampleEvent = z.infer<typeof resourceSampleSchema>;
