/**
 * The seam between the project **context document** and the project **metadata
 * store** (ADR 0051 §5, design sketch §E.1 / §E.2).
 *
 * The context document reports two things the collector does not yet store:
 * a **glossary** ("`btn_01` is the buy button") and recent **annotations**
 * ("launch of the v2 lobby"). Those live in the metadata write path, which is a
 * separate, larger change — its own tables, endpoints, capability checks and MCP
 * tools. Rather than block the context on it, or leave a hole in the document
 * that clients would have to learn about twice, the context reads them through
 * this narrow interface and ships with a provider that returns nothing.
 *
 * So today the document always carries `definitions.glossary: []` and
 * `annotations.recent: []` — present, well-typed, and honest — and the metadata
 * write path fills them by supplying a real provider to `buildApp`, with no
 * change to the route, the schema or any client.
 */

/** What an annotation is pinned to (design sketch §E.2). */
export type AnnotationTargetKind = "project" | "scene" | "mesh" | "region" | "metric" | "window";

/** One glossary entry: a term this project's people use, and what it means. */
export interface GlossaryEntry {
  /** The term as it appears in the data or in conversation, e.g. `btn_01`. */
  term: string;
  /** What it actually means, in one short sentence. */
  meaning: string;
}

/** One annotation, as the context document reports it. */
export interface AnnotationSummary {
  id: string;
  /** What the note is pinned to. */
  target: { kind: AnnotationTargetKind; id: string | null };
  text: string;
  /** When the note was made, epoch milliseconds. */
  at: number;
}

/**
 * Project-scoped metadata the context document includes when a store for it
 * exists. Implementations are read-only from the context's point of view: the
 * write path has its own endpoints and its own `annotate` capability check.
 */
export interface ProjectMetadataProvider {
  /** The project's glossary, or an empty list when none is stored. */
  glossary(projectId: string): Promise<readonly GlossaryEntry[]>;
  /**
   * The project's most recent annotations, newest first, capped at `limit`.
   * Empty when none are stored.
   */
  recentAnnotations(projectId: string, limit: number): Promise<readonly AnnotationSummary[]>;
}

/**
 * The provider used until the metadata write path exists: it stores nothing and
 * reports nothing. Deliberately not `null`/optional at the call site — the
 * context route asks the same questions either way, so there is exactly one code
 * path to reason about and to test.
 */
export const EMPTY_PROJECT_METADATA: ProjectMetadataProvider = {
  glossary: async () => [],
  recentAnnotations: async () => [],
};
