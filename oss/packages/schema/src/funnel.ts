import { z } from "zod";
import { EVENT_TYPES } from "./constants.js";
import { LIMITS } from "./limits.js";

/**
 * Funnel-step configuration contract (ADR 0038).
 *
 * A funnel is an **ordered** sequence of application-specific steps
 * (e.g. _open → rotate → select → zoom_); the funnel aggregation reports how
 * many sessions reach each step in order, exposing where visitors drop off.
 *
 * Because "rotate"/"select" map to different events per project, a step is a
 * **closed, validated predicate over an existing event** — never free-form SQL
 * and never a new event type (golden rule 2, "events live once"). Each predicate
 * compiles to equality on columns the store already promotes
 * (`event_type`, `name`, `mesh`), so it renders identically on every engine
 * (ADR 0020) and is injection-safe.
 *
 * This is a **config** shape, not an event: it is not part of the event union.
 * The OSS dashboard is a passive viewer with no authoring surface, so in OSS the
 * steps are supplied as request input (the funnel query endpoint) — provisioned
 * by the caller (CLI/seed/hosted), not edited in the dashboard. The interactive
 * configurator UI and persistence live hosted (ADR 0038).
 */

/** The set of event types a funnel step may match (mirrors {@link EVENT_TYPES}). */
export const funnelStepEventTypeSchema = z.enum(EVENT_TYPES);
export type FunnelStepEventType = z.infer<typeof funnelStepEventTypeSchema>;

/**
 * One ordered funnel step: a predicate matched against a single event.
 *
 * - `type` — required event type (e.g. `camera_gesture`, `mesh_interaction`,
 *   `pointer_click`, `custom`).
 * - `name` — optional discriminator matched against the promoted `name` column,
 *   which carries the **gesture kind** for `camera_gesture` (`orbit`/`pan`/…),
 *   the **interaction kind** for `mesh_interaction` (`hover`/`pick`/`select`/…),
 *   and the **custom event name** for `custom`.
 * - `mesh` — optional mesh-name match for `mesh_interaction` / `pointer_click`.
 * - `label` — optional human label for display; defaults to the predicate.
 *
 * Wildcards, numeric thresholds, and boolean combinations are intentionally out
 * of scope for v1 and can be added later without breaking stored configs.
 */
export const funnelStepSchema = z.object({
  type: funnelStepEventTypeSchema,
  name: z.string().min(1).max(LIMITS.maxCustomNameLength).optional(),
  mesh: z.string().min(1).max(LIMITS.maxMeshNameLength).optional(),
  label: z.string().min(1).max(120).optional(),
});
export type FunnelStep = z.infer<typeof funnelStepSchema>;

/**
 * An ordered list of funnel steps. **Array order is the funnel order.** A funnel
 * needs at least two steps to have a conversion between them.
 */
export const funnelStepsSchema = z.array(funnelStepSchema).min(2).max(20);
export type FunnelSteps = z.infer<typeof funnelStepsSchema>;

/** Current funnel-config wire version (versioned like the scene proxy). */
export const FUNNEL_CONFIG_VERSION = 1;

/**
 * A complete, persistable funnel definition keyed per project by `funnelId`.
 * OSS does not persist these (the dashboard is a passive viewer); the shape is
 * the shared contract the hosted configurator reads/writes and the funnel
 * aggregation consumes (ADR 0038).
 */
export const funnelConfigSchema = z.object({
  funnelId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/),
  label: z.string().min(1).max(120),
  steps: funnelStepsSchema,
  schemaVersion: z.literal(FUNNEL_CONFIG_VERSION).default(FUNNEL_CONFIG_VERSION),
});
export type FunnelConfig = z.infer<typeof funnelConfigSchema>;
