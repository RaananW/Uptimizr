import { z } from "zod";

/**
 * Ingestion payload bounds.
 *
 * The collector's write endpoint (`POST /api/v1/collect`) is public and
 * intentionally keyless (ADR 0003), so every free-text and collection field that
 * crosses the wire MUST be bounded at the schema boundary. These caps keep a
 * single batch from being used to exhaust memory/storage or to smuggle huge blobs
 * through the analytics path. They are deliberately generous — large enough for
 * legitimate connectors, small enough to be safe — and live here, with the event
 * shapes, so producers and the collector agree on the same numbers.
 *
 * When a field exceeds its cap the event (and therefore its batch) is rejected
 * with `400`. Connectors should truncate locally before sending rather than rely
 * on rejection (see the per-connector guidance in the schema README).
 */
export const LIMITS = {
  /** Maximum number of events accepted in a single `collectRequest` batch. */
  maxBatchEvents: 1000,

  /** Project identifier (public, non-secret). */
  maxProjectIdLength: 128,
  /** Session identifier (client-generated, in-memory). */
  maxSessionIdLength: 128,
  /** Producing SDK version string. */
  maxSdkVersionLength: 64,
  /** Page URL hosting the scene. */
  maxUrlLength: 2048,

  /** Page/document title in `pageMeta`. */
  maxTitleLength: 512,
  /** Referrer URL in `pageMeta`. */
  maxReferrerLength: 2048,
  /** BCP-47 language tag in `pageMeta`. */
  maxLanguageLength: 35,

  /** Mesh / object name on interaction and visibility events. */
  maxMeshNameLength: 256,
  /** Asset name or URL on `asset_load`. */
  maxAssetNameLength: 1024,

  /** Custom event name. */
  maxCustomNameLength: 128,
  /** A single custom-prop string value. */
  maxCustomPropValueLength: 1024,
  /** Number of entries in a custom event's `props` record. */
  maxCustomPropEntries: 64,

  /** Caller-supplied user id (must be pseudonymous, never PII — ADR 0003). */
  maxUserIdLength: 128,
  /** A single user-trait string value. */
  maxUserTraitValueLength: 1024,
  /** Number of entries in the user `traits` record. */
  maxUserTraitEntries: 64,

  /** Free-text scene description in `session_start` scene metadata. */
  maxSceneDescriptionLength: 256,
  /** Active camera name in `session_start` scene metadata. */
  maxCameraNameLength: 128,

  /** Per-mesh name in a scene proxy. */
  maxSceneProxyMeshNameLength: 256,
  /** Per-mesh engine node path in a scene proxy (ADR 0033 reconstruction). */
  maxSceneProxyMeshPathLength: 512,
  /** Number of meshes carried in a single scene proxy (connectors cap huge scenes). */
  maxSceneProxyMeshes: 10_000,

  /** Human label of a scene region (ADR 0051 §2 / sketch §B.2). */
  maxSceneRegionLabelLength: 120,
  /** Free-text description of a scene region. */
  maxSceneRegionDescriptionLength: 500,
  /** Number of regions one scene may declare (curated metadata, not a payload). */
  maxSceneRegions: 200,

  /** Developer-declared scene-actor id on `node_transform` (ADR 0027). */
  maxNodeIdLength: 128,
  /** Skeleton bone name on `node_transform` Tier-2 samples (ADR 0027). */
  maxBoneIdLength: 128,
  /** Relative engine node path of a Tier-1 subtree child on `node_transform` (ADR 0033). */
  maxChildPathLength: 512,

  /**
   * Free-text diagnostic message on `graphics_diagnostic` (ADR 0021 part 2). May
   * embed GPU/driver/shader error text, so it is length-capped and the deployer
   * redacts via `beforeSend`. Raw shader source is a separate sub-opt-in.
   */
  maxGraphicsDiagnosticMessageLength: 1024,
  /** Short diagnostic code on `graphics_diagnostic` (e.g. GL error / `GPUError` subtype). */
  maxGraphicsDiagnosticCodeLength: 64,

  // --- Project metadata (ADR 0051 §5 / sketch §E.2) -------------------------
  // Not ingestion: these bound the authenticated **metadata write path**
  // (annotations, glossary, saved analyses). They live here with the rest of the
  // wire bounds so the schema, the collector and every store agree on one set of
  // numbers. The `maxProject*` caps are enforced by the store at write time — a
  // project's metadata is a curated set of notes, not a growth surface.

  /** Free text of one annotation. */
  maxAnnotationTextLength: 2000,
  /** Identifier an annotation points at (a scene, mesh, region or metric id). */
  maxAnnotationTargetIdLength: 256,
  /** Annotations one project may hold. */
  maxProjectAnnotations: 500,

  /** Glossary term — the key half of one entry. */
  maxGlossaryTermLength: 64,
  /** Glossary meaning — the definition half of one entry. */
  maxGlossaryMeaningLength: 500,
  /** Glossary entries one project may hold. */
  maxProjectGlossaryEntries: 200,

  /** Saved-analysis title. */
  maxSavedAnalysisTitleLength: 120,
  /** Saved-analysis conclusion (the written finding). */
  maxSavedAnalysisConclusionLength: 4000,
  /** Serialized length of a saved analysis' `query` document. */
  maxSavedAnalysisQueryLength: 8000,
  /** Saved analyses one project may hold. */
  maxProjectSavedAnalyses: 200,
} as const;

/**
 * A bounded record: at most `maxEntries` keys, each mapping to `value`. Zod has no
 * built-in cap on the number of record keys, so this adds one via a refinement.
 * Used for the open `props` / `traits` extension points.
 */
export function boundedRecord<T extends z.ZodTypeAny>(value: T, maxEntries: number) {
  return z.record(z.string(), value).refine((record) => Object.keys(record).length <= maxEntries, {
    message: `must have at most ${maxEntries} entries`,
  });
}
