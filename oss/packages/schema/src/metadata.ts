import { z } from "zod";
import { LIMITS } from "./limits.js";

/**
 * **Project metadata** — the things people and agents leave behind next to the
 * numbers: a note on a spike (`annotation`), a definition of a name that only
 * this project's team knows (`glossary`), and a question worth re-asking with
 * the answer it got (`saved analysis`). ADR 0051 §5, design sketch §E.2.
 *
 * Like `funnel.ts` and `sceneRegion.ts` these are **config / metadata** shapes,
 * not analytics events: they are deliberately not part of the event union and
 * never reach the public ingest path. Events stay read-only (ADR 0051 §9) — the
 * only writes these shapes describe go to the authenticated, `annotate`-gated
 * metadata endpoints, where every one of them is audited.
 *
 * They are still wire contracts (the collector endpoints, the MCP write tools
 * and the dashboard assistant all send them), so they live here and are
 * validated once, at the boundary.
 *
 * **Privacy (ADR 0003).** Metadata is free text written by a project's own
 * operators and agents, so unlike captured events it is *not* machine-bounded
 * to non-PII — but it is also never captured from a visitor. It is
 * project-scoped, readable only with that project's key, bounded in size and
 * count, and the docs tell self-hosters not to paste personal data into it.
 */

/**
 * What an annotation is *about*. A closed union, because the dashboard and the
 * agent both branch on it: the time axis renders `window` and `project` notes,
 * a mesh drill-down shows its `mesh` notes, and so on.
 *
 * - `project` — a standing note about the whole project ("v2.1 shipped on the
 *   3rd").
 * - `scene` / `mesh` / `region` — a note pinned to a place in the experience;
 *   `targetId` is the scene id, mesh name or region id.
 * - `metric` — a note about one registry metric ("`jank_rate` is noisy on
 *   mobile Safari"); `targetId` is the metric id.
 * - `window` — a note about a period of time rather than a thing; `since` marks
 *   when it starts.
 */
export const annotationTargetKindSchema = z.enum([
  "project",
  "scene",
  "mesh",
  "region",
  "metric",
  "window",
]);
export type AnnotationTargetKind = z.infer<typeof annotationTargetKindSchema>;

/** The target kinds that name something and therefore require a `targetId`. */
const TARGETED_KINDS = new Set<AnnotationTargetKind>(["scene", "mesh", "region", "metric"]);

/**
 * One annotation as written by a client: what it is about, optionally when it
 * applies, and the note itself.
 *
 * The time range is epoch milliseconds so it needs no timezone agreement and
 * lines up with every query range in the API. Both bounds are optional — an
 * annotation with neither is a standing note, one with only `since` is a moment
 * ("the deploy"), and one with both is a period ("the outage").
 */
export const annotationSchema = z
  .object({
    /** What the note is about. */
    targetKind: annotationTargetKindSchema,
    /**
     * The thing named by {@link annotationTargetKindSchema}: a scene id, mesh
     * name, region id or metric id. Required for those kinds, meaningless for
     * `project` and `window`.
     */
    targetId: z.string().min(1).max(LIMITS.maxAnnotationTargetIdLength).optional(),
    /** Start of the period the note applies to, epoch ms. */
    since: z.number().int().nonnegative().optional(),
    /** End of the period the note applies to, epoch ms. Must be >= `since`. */
    until: z.number().int().nonnegative().optional(),
    /** The note. Free text, bounded — a note, not a document store. */
    text: z.string().min(1).max(LIMITS.maxAnnotationTextLength),
  })
  .refine((a) => !TARGETED_KINDS.has(a.targetKind) || a.targetId != null, {
    message: "targetId is required for scene, mesh, region and metric annotations",
    path: ["targetId"],
  })
  .refine((a) => a.targetKind !== "window" || a.since != null, {
    message: "a window annotation must carry a since timestamp",
    path: ["since"],
  })
  .refine((a) => a.since == null || a.until == null || a.until >= a.since, {
    message: "until must be greater than or equal to since",
    path: ["until"],
  });
export type Annotation = z.infer<typeof annotationSchema>;

/**
 * Characters a glossary term may not contain: control characters (a term ends
 * up in a URL path, a JSON document and a database key) and `/`, which would
 * split the `PUT /api/v1/glossary/:term` path segment.
 */
function isForbiddenInTerm(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return char === "/" || code < 0x20 || code === 0x7f;
}

/**
 * A glossary term: the key half of one entry. Terms are words a team already
 * uses — "checkout counter", "mesh_0042", "TTFR" — so spaces and punctuation
 * are allowed, but control characters and `/` are not: the term is the path
 * segment of `PUT /api/v1/glossary/:term`, and the store's primary key.
 */
export const glossaryTermSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxGlossaryTermLength)
  .refine((term) => term.trim() === term, {
    message: "term must not have leading or trailing whitespace",
  })
  // A plain character scan rather than a regex: a class of control characters
  // is hard to read, easy to get wrong, and needs a lint exemption.
  .refine((term) => ![...term].some(isForbiddenInTerm), {
    message: "term must not contain control characters or /",
  });
export type GlossaryTerm = z.infer<typeof glossaryTermSchema>;

/**
 * One glossary entry as written by a client. The term is the identity of the
 * entry (writes are idempotent upserts keyed by it), the meaning is what the
 * project's people and agents should understand by it.
 */
export const glossaryEntrySchema = z.object({
  term: glossaryTermSchema,
  /** What the term means, in this project. */
  meaning: z.string().min(1).max(LIMITS.maxGlossaryMeaningLength),
});
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

/**
 * The stored question of a saved analysis.
 *
 * It is an **opaque bounded JSON object** here on purpose. The query DSL
 * (`queryV1`, ADR 0051 §3 / sketch §C.1) lands in a separate change; until a
 * saved analysis can be re-run against a schema-checked DSL document, this
 * contract promises only what it can keep — that the stored question is a JSON
 * object and that it is small. Whoever re-runs it validates it then, which is
 * the same posture the collector takes towards any document it stores but does
 * not interpret.
 *
 * Bounding is by serialized length rather than key count: it is the number that
 * actually protects the row, and it is the one the store can also check.
 */
export const savedAnalysisQuerySchema = z
  .record(z.string(), z.unknown())
  .refine((query) => JSON.stringify(query).length <= LIMITS.maxSavedAnalysisQueryLength, {
    message: `query must serialize to at most ${LIMITS.maxSavedAnalysisQueryLength} characters`,
  });
export type SavedAnalysisQuery = z.infer<typeof savedAnalysisQuerySchema>;

/**
 * One saved analysis as written by a client: a title someone will recognise in
 * a list, the question that produced it, and what was concluded.
 *
 * `conclusion` is optional because an analysis is worth saving before it has an
 * answer ("watch this one") — but it is the field that makes the record useful
 * to the next reader, so clients should fill it.
 */
export const savedAnalysisSchema = z.object({
  /** Short human title, shown in listings and in the project context document. */
  title: z.string().min(1).max(LIMITS.maxSavedAnalysisTitleLength),
  /** The question, as an opaque bounded JSON document — see {@link savedAnalysisQuerySchema}. */
  query: savedAnalysisQuerySchema,
  /** What was concluded from it, in words. */
  conclusion: z.string().max(LIMITS.maxSavedAnalysisConclusionLength).optional(),
});
export type SavedAnalysis = z.infer<typeof savedAnalysisSchema>;

/**
 * Who wrote a metadata row. `user` is a person acting through a first-party UI;
 * `agent` is anything else holding an `annotate` key — an MCP client, the
 * in-browser assistant, a scripted report. The collector derives it from the
 * same client marker the agent audit log uses (ADR 0051 §7), never from the
 * payload, so a row cannot claim to be something it is not.
 */
export const metadataAuthorKindSchema = z.enum(["user", "agent"]);
export type MetadataAuthorKind = z.infer<typeof metadataAuthorKindSchema>;
