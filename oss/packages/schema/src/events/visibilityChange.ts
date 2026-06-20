import { z } from "zod";
import { defineEvent } from "./defineEvent.js";

/** Page visibility states tracked by the SDK (`document.visibilityState`). */
export const visibilityStateSchema = z.enum(["visible", "hidden"]);
export type VisibilityState = z.infer<typeof visibilityStateSchema>;

/**
 * Ordered marker recording a change in page visibility (the tab was backgrounded
 * or restored). When hidden, the browser throttles or stops the render loop, so
 * gaps in `camera_sample`/`frame_perf` line up with these markers. Distinct from
 * {@link focusChangeSchema}: visibility is about the tab being shown at all,
 * focus is about input target.
 */
export const visibilityChangeSchema = defineEvent("visibility_change", {
  /** Visibility state the page transitioned to. */
  state: visibilityStateSchema,
});
export type VisibilityChangeEvent = z.infer<typeof visibilityChangeSchema>;
