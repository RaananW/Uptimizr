import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { LIMITS } from "../limits.js";

/**
 * Asset / scene load performance. Captures how long assets took to load and the
 * time-to-first-frame, helping creators understand startup experience.
 */
export const assetLoadSchema = defineEvent("asset_load", {
  /** Asset name or URL (may be sanitized by the SDK). */
  name: z.string().max(LIMITS.maxAssetNameLength),
  /** Asset size in bytes, when known. */
  bytes: z.number().nonnegative().optional(),
  /** Load duration in milliseconds. */
  loadMs: z.number().nonnegative(),
  /** Time-to-first-frame in milliseconds, when this is the initial scene load. */
  ttffMs: z.number().nonnegative().optional(),
  /**
   * Time-to-interactive in milliseconds (#45, design §C): when the scene became
   * actually usable — assets streamed in and input wired — as opposed to merely
   * presenting its first frame (`ttffMs`). The host app decides what "interactive"
   * means and reports it.
   */
  ttiMs: z.number().nonnegative().optional(),
});
export type AssetLoadEvent = z.infer<typeof assetLoadSchema>;
