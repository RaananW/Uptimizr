import { z } from "zod";
import { aabbSchema } from "./sceneProxy.js";
import { LIMITS } from "./limits.js";

/**
 * Scene **regions** — a developer-authored vocabulary for *where* things happen
 * in a 3D scene (ADR 0051 §2, sketch §B.2), extending the scene registry
 * (ADR 0014).
 *
 * Spatial results are coordinates; humans and agents need shared names — "the
 * entrance", "the checkout counter" — to talk about them. A region is a labelled
 * axis-aligned box in the scene's world space, keyed by a stable `id` within its
 * scene, that a spatial query can be filtered to (`region=<id>` resolves to the
 * same {@link aabbSchema} box ADR 0040's region drill-down already takes).
 *
 * Regions **may overlap**: membership is "all regions containing the point" and
 * the reported `region` is the smallest by volume. That labelling step is a
 * separate change (#302); this contract only defines the stored shape.
 *
 * Like `funnel.ts` this is a **config / metadata** shape, not an analytics event
 * — it is deliberately not part of the event union and never reaches the public
 * ingest path. It is still a wire contract (the registry endpoint, the SDK
 * helper, and the CLI all send it), so it lives here and is validated at the
 * boundary.
 */

/**
 * Developer-assigned region identifier, stable within its scene. Constrained
 * like {@link sceneIdSchema}: it is a low-cardinality key that appears in
 * querystrings and in stored rows, so charset and length are bounded.
 *
 * Privacy: a region is a **place** key, never a user/session key. It MUST NOT
 * carry PII (ADR 0003).
 */
export const regionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, "region id must be 1-64 chars of [A-Za-z0-9._:-]");
export type RegionId = z.infer<typeof regionIdSchema>;

/**
 * One named region of a scene: a stable `id`, a human label, the world-space
 * box it covers, and an optional free-text description an agent can read for
 * context ("where visitors queue to pay").
 */
export const sceneRegionSchema = z.object({
  /** Stable region identifier, unique within the scene. */
  id: regionIdSchema,
  /** Human-friendly name shown in dashboards, summaries, and agent answers. */
  label: z.string().min(1).max(LIMITS.maxSceneRegionLabelLength),
  /**
   * World-space axis-aligned bounding box `[minX,minY,minZ,maxX,maxY,maxZ]` in
   * the scene's canonical frame (ADR 0018) — the same encoding a scene proxy's
   * mesh boxes use, so a region and the proxy backdrop share one coordinate
   * space. `max` must be `>=` `min` on every axis.
   */
  bounds: aabbSchema.refine(
    ([minX, minY, minZ, maxX, maxY, maxZ]) => maxX >= minX && maxY >= minY && maxZ >= minZ,
    { message: "region bounds max must be >= min on every axis" },
  ),
  /** Optional free-text note about what the region is / why it matters. */
  description: z.string().max(LIMITS.maxSceneRegionDescriptionLength).optional(),
});
export type SceneRegion = z.infer<typeof sceneRegionSchema>;

/**
 * The complete region set of one scene. The authoring endpoint replaces the
 * scene's set wholesale, so an empty array is meaningful ("this scene has no
 * regions"). Bounded at the boundary — a region set is small, curated metadata,
 * not a payload to smuggle a blob through — and region ids must be unique.
 */
export const sceneRegionsSchema = z
  .array(sceneRegionSchema)
  .max(LIMITS.maxSceneRegions)
  .refine((regions) => new Set(regions.map((r) => r.id)).size === regions.length, {
    message: "region ids must be unique within a scene",
  });
export type SceneRegions = z.infer<typeof sceneRegionsSchema>;
