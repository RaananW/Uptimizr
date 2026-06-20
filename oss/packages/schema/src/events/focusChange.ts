import { z } from "zod";
import { defineEvent } from "./defineEvent.js";

/**
 * Ordered marker recording the canvas/window gaining or losing input focus.
 * Babylon throttles its render loop when the canvas is not focused, so a blurred
 * stretch explains why the scene stops updating even while the tab is still
 * visible. Distinct from {@link visibilityChangeSchema}: focus is about the input
 * target, visibility is about the tab being shown at all.
 */
export const focusChangeSchema = defineEvent("focus_change", {
  /** Whether the tracked surface is now focused. */
  focused: z.boolean(),
});
export type FocusChangeEvent = z.infer<typeof focusChangeSchema>;
