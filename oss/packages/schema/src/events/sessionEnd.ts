import { z } from "zod";
import { defineEvent } from "./defineEvent.js";

/**
 * Emitted when a session ends (page hidden/unloaded or explicit stop).
 */
export const sessionEndSchema = defineEvent("session_end", {
  /** Total session duration in milliseconds, if known. */
  durationMs: z.number().nonnegative().optional(),
  /** How the session ended. */
  reason: z.enum(["unload", "hidden", "manual", "timeout"]).optional(),
});
export type SessionEndEvent = z.infer<typeof sessionEndSchema>;
