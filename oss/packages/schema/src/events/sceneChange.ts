import type { z } from "zod";
import { defineEvent } from "./defineEvent.js";

/**
 * Ordered marker emitted when the host app switches the active scene/area via
 * `setScene(...)` (ADR 0010). It carries no payload of its own: the envelope's
 * `sceneId` records the scene now active (and its absence means the `"default"`
 * scene). The marker exists so a replay timeline records *when* the transition
 * happened, even across stretches with no spatial events.
 */
export const sceneChangeSchema = defineEvent("scene_change", {});
export type SceneChangeEvent = z.infer<typeof sceneChangeSchema>;
