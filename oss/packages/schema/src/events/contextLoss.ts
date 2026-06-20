import { z } from "zod";
import { defineEvent } from "./defineEvent.js";

/**
 * Emitted when the rendering engine loses its GPU context (WebGL/WebGPU).
 * Rendering is suspended until a matching `context_restored` arrives.
 */
export const contextLostSchema = defineEvent("context_lost", {
  /** Optional human-readable reason, if the engine reports one. */
  reason: z.string().max(512).optional(),
});
export type ContextLostEvent = z.infer<typeof contextLostSchema>;

/**
 * Emitted when the rendering engine recovers its GPU context after a loss.
 */
export const contextRestoredSchema = defineEvent("context_restored", {});
export type ContextRestoredEvent = z.infer<typeof contextRestoredSchema>;
