import { z } from "zod";
import { defineEvent } from "./defineEvent.js";

/**
 * The drawing surface (canvas) changed size. Emitted on canvas/window resize
 * (debounced by the SDK) and once at session start so every session has a known
 * starting viewport. 2D pointer/screen coordinates are only meaningful relative
 * to the viewport they were captured in, so this is what lets a consumer
 * normalize pointer heatmaps across resizes and devices.
 */
export const viewportResizeSchema = defineEvent("viewport_resize", {
  /** Canvas/drawing-buffer width in CSS pixels. */
  width: z.number().positive(),
  /** Canvas/drawing-buffer height in CSS pixels. */
  height: z.number().positive(),
  /** Device pixel ratio at capture time, when available. */
  dpr: z.number().positive().optional(),
});
export type ViewportResizeEvent = z.infer<typeof viewportResizeSchema>;
