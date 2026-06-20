import { z } from "zod";

/**
 * Reusable primitive schemas shared across events.
 *
 * Vectors are encoded as fixed-length numeric tuples rather than objects to keep
 * the high-volume event payloads compact on the wire and in columnar storage.
 */

/** 3D vector `[x, y, z]`. */
export const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof vec3Schema>;

/** Quaternion `[x, y, z, w]`. Encoded as a tuple to stay compact in high-volume
 * transform streams (ADR 0027). Not auto-normalized — connectors emit unit
 * quaternions; replay may renormalize defensively. */
export const quatSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Quat = z.infer<typeof quatSchema>;

/** 2D vector `[x, y]`. */
export const vec2Schema = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof vec2Schema>;

/**
 * Screen-normalized 2D position in the `[0, 1]` range, origin top-left.
 * Resolution-independent so heatmaps aggregate across devices.
 */
export const normalized2Schema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export type Normalized2 = z.infer<typeof normalized2Schema>;

/** Epoch milliseconds. */
export const epochMsSchema = z.number().int().nonnegative();

/**
 * Developer-assigned scene / area identifier (the spatial-heatmap dimension —
 * ADR 0010). A stable, low-cardinality label for a distinct space within an app,
 * e.g. `"lobby"`, `"level-3"`, `"product-configurator"`.
 *
 * Constrained on purpose: it lands in a ClickHouse `LowCardinality` column and is
 * grouped/filtered in heatmap queries, so it MUST stay low-cardinality. Charset
 * and length are bounded to protect that.
 *
 * Privacy: this is a **scene** key, never a user/session key. It MUST NOT contain
 * PII or per-user / per-page-load values (that would explode cardinality and leak
 * identity — see ADR 0003). The default scene is {@link DEFAULT_SCENE_ID}.
 */
export const sceneIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, "sceneId must be 1-64 chars of [A-Za-z0-9._:-]");
export type SceneId = z.infer<typeof sceneIdSchema>;
