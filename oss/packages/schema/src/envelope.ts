import { z } from "zod";
import { epochMsSchema, sceneIdSchema } from "./primitives.js";
import { LIMITS } from "./limits.js";

/**
 * The common envelope carried by every event.
 *
 * Extensibility: optional blocks (`pageMeta`) can gain fields without breaking
 * existing producers/consumers. Required fields are intentionally minimal.
 *
 * Privacy: `visitorId` is **server-set** (a daily-rotating hash). Clients MUST NOT
 * send it; the collector derives and attaches it during ingestion (see ADR 0003).
 */

/**
 * Page / document context for the session. Coarse and non-identifying by design.
 * New optional fields may be added over time.
 */
export const pageMetaSchema = z
  .object({
    /** Document title at capture time. */
    title: z.string().max(LIMITS.maxTitleLength).optional(),
    /** Referrer URL, if available and permitted. */
    referrer: z.string().max(LIMITS.maxReferrerLength).optional(),
    /** Viewport size in CSS pixels `[width, height]`. */
    viewport: z.tuple([z.number(), z.number()]).optional(),
    /** Device pixel ratio. */
    devicePixelRatio: z.number().positive().optional(),
    /** BCP-47 language tag, e.g. `en-US`. */
    language: z.string().max(LIMITS.maxLanguageLength).optional(),
  })
  .passthrough();
export type PageMeta = z.infer<typeof pageMetaSchema>;

/**
 * Shared envelope fields. Individual events extend this with a `type` discriminant
 * and their own payload via `defineEvent`.
 */
export const envelopeShape = {
  /** Project the event belongs to (public, non-secret identifier). */
  projectId: z.string().min(1).max(LIMITS.maxProjectIdLength),
  /** Server-assigned cookieless visitor hash. Omitted by clients. */
  visitorId: z.string().optional(),
  /** Groups events from a single visit. Generated client-side, in-memory only. */
  sessionId: z.string().min(1).max(LIMITS.maxSessionIdLength),
  /** Event timestamp in epoch milliseconds. */
  ts: epochMsSchema,
  /** Version of the SDK that produced the event. */
  sdkVersion: z.string().min(1).max(LIMITS.maxSdkVersionLength),
  /** URL of the page hosting the 3D scene. */
  url: z.string().max(LIMITS.maxUrlLength).optional(),
  /**
   * Developer-assigned scene/area the event belongs to (ADR 0010). Stamped by the
   * SDK on every event; omitted by clients that never call `setScene(...)`, in
   * which case the collector treats it as {@link DEFAULT_SCENE_ID}.
   */
  sceneId: sceneIdSchema.optional(),
  /** Optional page/document context. */
  pageMeta: pageMetaSchema.optional(),
} as const;

export const envelopeSchema = z.object(envelopeShape);
export type Envelope = z.infer<typeof envelopeSchema>;
