import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { inputSourceShape } from "./inputSource.js";

/**
 * What *class* of capability changed. Kept deliberately small so it stays a
 * meaningful group key (not a free-form bag):
 *
 * - `graphics-backend` — the rendering backend changed, typically a WebGPU→WebGL2
 *   downgrade (engine init fell back, or a WebGPU device was lost and re-created
 *   on WebGL2).
 * - `quality`          — an app/engine quality or LOD tier auto-downgraded (or
 *   upgraded) at runtime to hold framerate (e.g. shadow/ resolution/ LOD bias).
 * - `device-recovery`  — the renderer recovered from a lost device and
 *   re-initialised, possibly at a *different* capability. This is the higher-level
 *   companion to the raw `context_lost` / `context_restored` lifecycle events: it
 *   records what the app came back as, not just that it came back.
 * - `tracking`         — XR spatial tracking quality changed (ADR 0048): hand or
 *   inside-out controller tracking degraded or dropped under occlusion / poor
 *   lighting (e.g. `"6dof"`→`"3dof"`, `"hand"`→`"lost"`, `"controller"`→
 *   `"occluded"`). Carries `source`/`handedness` so a dashboard can split by which
 *   hand/controller degraded, and an optional `durationMs` for how long the
 *   degraded episode lasted. App/connector-reported and best-effort, exactly like
 *   `device-recovery` — runtimes rarely expose a clean tracking-confidence hook.
 * - `feature`          — a specific optional feature was turned off/on (e.g. a
 *   post-process disabled because an extension was unavailable).
 * - `other`            — anything the app can't attribute to the above.
 */
export const capabilityChangeKindSchema = z.enum([
  "graphics-backend",
  "quality",
  "device-recovery",
  "tracking",
  "feature",
  "other",
]);

export type CapabilityChangeKind = z.infer<typeof capabilityChangeKindSchema>;

/**
 * Capability / fidelity fallback or recovery (#49, design §E). Explains
 * perf and visual-fidelity *variance across the user base*: a scene that runs on
 * WebGPU for some visitors and falls back to WebGL2 for others, or auto-downgrades
 * quality on weaker devices, will otherwise look like unexplained noise in the
 * aggregate metrics. Pairs with the existing `context_lost` / `context_restored`
 * lifecycle events (which record the raw GPU interruption); this records the
 * *capability decision* the app made.
 *
 * Auto-detection is limited — engines decide their backend at init and rarely
 * expose a runtime "I downgraded" hook — so this is primarily **app-reported**
 * via `client.reportCapabilityChange(...)`. The host app knows when it fell back
 * or re-initialised; it reports the transition with short, app-defined tokens.
 *
 * Privacy (ADR 0003): `from` / `to` / `reason` must be low-cardinality,
 * app-defined labels (e.g. `"webgpu"`, `"webgl2"`, `"high"`, `"low"`) — never raw
 * device strings or PII. Lengths are capped to keep cardinality and payload bounded.
 */
export const capabilityChangeSchema = defineEvent("capability_change", {
  /** What class of capability changed. */
  kind: capabilityChangeKindSchema,
  /** Previous capability/level as a short app-defined token (e.g. `"webgpu"`). */
  from: z.string().max(64).optional(),
  /** New capability/level as a short app-defined token (e.g. `"webgl2"`). */
  to: z.string().max(64).optional(),
  /** Optional short, app-defined reason for the change (no PII). */
  reason: z.string().max(120).optional(),
  /**
   * How long a transient degraded state lasted, in ms — used by the `tracking`
   * kind (ADR 0048) to report a completed degradation episode (from good tracking
   * `from`, into degraded tracking `to`, for `durationMs`), the way `compile_stall`
   * / `hover_dwell` report one bucketed duration per occurrence. Feeds the
   * tracking-quality timeline (% of session spent with degraded/lost tracking).
   * Absent on the non-tracking kinds, which are instantaneous transitions.
   */
  durationMs: z.number().nonnegative().optional(),
  /**
   * Which XR input source degraded and (for paired sources) which hand, spread
   * from the shared {@link inputSourceShape} (ADR 0011). Populated by the
   * `tracking` kind so the timeline can split hand vs. controller; absent on the
   * other kinds. Only `source`/`handedness` are meaningful here.
   */
  ...inputSourceShape,
});

export type CapabilityChangeEvent = z.infer<typeof capabilityChangeSchema>;
