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
 * The metadata write path (#310) now exists, so {@link storeProjectMetadata}
 * is the default: it reads the same two list methods the write path exposes.
 * {@link EMPTY_PROJECT_METADATA} remains for a caller — a test, an embedding —
 * that has no metadata store, and the route asks the same questions either way,
 * so there is exactly one code path to reason about and to test.
 */

import type { AnnotationRecord, GlossaryEntryRecord, ListAnnotationsOptions } from "@uptimizr/db";

/**
 * The slice of `CollectorStore` this seam reads. Declared structurally rather
 * than importing the whole store type, so the provider stays testable with a
 * two-method stub and cannot reach anything else.
 */
export interface ProjectMetadataStore {
  listGlossary(projectId: string): Promise<GlossaryEntryRecord[]>;
  listAnnotations(projectId: string, opts?: ListAnnotationsOptions): Promise<AnnotationRecord[]>;
}

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
 * A provider that stores nothing and reports nothing. The default until #310
 * landed; still used by a caller with no metadata store, and by the tests that
 * assert the context document is well-formed when the two lists are empty.
 */
export const EMPTY_PROJECT_METADATA: ProjectMetadataProvider = {
  glossary: async () => [],
  recentAnnotations: async () => [],
};

/**
 * The provider the collector uses by default: the project metadata store of
 * #310, read through the two list methods that path was given for exactly this
 * (`listGlossary(projectId)`, `listAnnotations(projectId, { limit })`).
 *
 * The context document is a **read**, so nothing here needs the `annotate`
 * capability — writing is the metadata route's job and has its own gate. Rows
 * are narrowed to what the document reports: a term and its meaning, and a
 * note's target, text and time. Nothing else from the stored row (its author,
 * its period, its `updatedAt`) reaches the context.
 */
export function storeProjectMetadata(store: ProjectMetadataStore): ProjectMetadataProvider {
  return {
    glossary: async (projectId) =>
      (await store.listGlossary(projectId)).map(({ term, meaning }) => ({ term, meaning })),
    recentAnnotations: async (projectId, limit) =>
      (await store.listAnnotations(projectId, { limit })).map((row) => ({
        id: row.id,
        target: { kind: row.targetKind, id: row.targetId },
        text: row.text,
        at: row.createdAt.getTime(),
      })),
  };
}
