import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  LIMITS,
  annotationSchema,
  annotationTargetKindSchema,
  glossaryTermSchema,
  savedAnalysisSchema,
} from "@uptimizr/schema";
import { MetadataLimitError, type AnnotationRecord, type SavedAnalysisRecord } from "@uptimizr/db";
import type { CollectorStore } from "../store.js";
import { metadataAuthorKind, requireCapability } from "../auth.js";

/**
 * **Project metadata** endpoints (#310, ADR 0051 §5, design sketch §E.2):
 * annotations, the glossary, and saved analyses.
 *
 * This is the collector's only writable surface besides ingestion, and it is
 * deliberately a separate plugin from `routes/query.ts` so the read API stays
 * exactly what it was: aggregate, read-only, and describable as such. Nothing
 * here touches the `events` tables.
 *
 * The rules, uniformly:
 *
 * - **Writes require `annotate`; reads require `query`.** A read-only key handed
 *   to an agent can read the project's notes but cannot leave any (#309).
 * - **Everything is project-scoped.** The project comes from the key, never from
 *   the request, so one project's notes are invisible to another's key.
 * - **Zod at the edge.** Every payload is one of the `@uptimizr/schema` metadata
 *   contracts, which bound each field's length; the store bounds the row *count*
 *   per project and answers `409` when a table is full.
 * - **Every write is audited.** The app-level audit hook records each one
 *   (ADR 0051 §7); nothing extra is needed here, and `__tests__/metadata.test.ts`
 *   pins that it happens.
 * - **Authorship is derived, not declared** — see `metadataAuthorKind`.
 */

interface Options {
  store: CollectorStore;
}

/** Generated row id in a path (`/annotations/:id`, `/analyses/:id`). */
const idParams = z.object({ id: z.string().min(1).max(128) });

/** `/glossary/:term` — the term itself is the key, bounded by the schema. */
const termParams = z.object({ term: glossaryTermSchema });

/** Filters for the annotation listing. */
const listAnnotationsQuery = z.object({
  targetKind: annotationTargetKindSchema.optional(),
  targetId: z.string().min(1).max(LIMITS.maxAnnotationTargetIdLength).optional(),
  since: z.coerce.number().int().nonnegative().optional(),
  until: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

/** Row cap shared by the glossary and saved-analysis listings. */
const listQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

/** The body of a glossary write: the term is in the path, the meaning here. */
const putGlossaryBody = z.object({
  meaning: z.string().min(1).max(LIMITS.maxGlossaryMeaningLength),
});

/** A `Date` as an ISO string, or null — how every timestamp leaves this API. */
function iso(value: Date | null): string | null {
  return value == null ? null : value.toISOString();
}

/** Wire shape of one annotation row. */
function toAnnotationBody(row: AnnotationRecord): Record<string, unknown> {
  return {
    ...row,
    since: iso(row.since),
    until: iso(row.until),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Wire shape of one saved-analysis row. */
function toAnalysisBody(row: SavedAnalysisRecord): Record<string, unknown> {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/**
 * Run a metadata write and turn a full project into a `409`.
 *
 * A cap breach is not a bad request — the payload was fine — and not a server
 * fault; it is a conflict with the project's current state that the caller
 * fixes by deleting something. Everything else propagates to Fastify's error
 * handler unchanged.
 */
async function withLimitGuard<T>(
  reply: FastifyReply,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof MetadataLimitError) {
      await reply.code(409).send({ error: err.message });
      return undefined;
    }
    throw err;
  }
}

export const metadataRoutes: FastifyPluginAsync<Options> = async (app, { store }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // --- Annotations ---------------------------------------------------------

  // A project's notes, newest first. `since`/`until` select the annotations
  // whose period *overlaps* the window (a standing note always matches), which
  // is what a dashboard time axis needs for the range it is showing.
  r.get(
    "/api/v1/annotations",
    { schema: { querystring: listAnnotationsQuery } },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "query");
      if (!resolved) return reply;
      const rows = await store.listAnnotations(resolved.projectId, req.query);
      return rows.map(toAnnotationBody);
    },
  );

  r.post("/api/v1/annotations", { schema: { body: annotationSchema } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "annotate");
    if (!resolved) return reply;
    const created = await withLimitGuard(reply, () =>
      store.createAnnotation(resolved.projectId, {
        annotation: req.body,
        authorKind: metadataAuthorKind(req),
        authorKeyId: resolved.keyId,
      }),
    );
    if (!created) return reply;
    return reply.code(201).send(toAnnotationBody(created));
  });

  // 404 for an unknown id *and* for one that belongs to another project — the
  // two are deliberately indistinguishable, so an id cannot be probed across
  // projects.
  r.delete("/api/v1/annotations/:id", { schema: { params: idParams } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "annotate");
    if (!resolved) return reply;
    const deleted = await store.deleteAnnotation(resolved.projectId, req.params.id);
    if (!deleted) return reply.code(404).send({ error: "annotation not found" });
    return reply.code(204).send();
  });

  // --- Glossary ------------------------------------------------------------

  r.get("/api/v1/glossary", { schema: { querystring: listQuery } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "query");
    if (!resolved) return reply;
    const rows = await store.listGlossary(resolved.projectId, req.query);
    return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
  });

  // Defining a term is an idempotent upsert: the term is the identity, so the
  // same PUT twice leaves one row with the newer meaning. That is why this is a
  // PUT on `/:term` and not a POST to a collection.
  r.put(
    "/api/v1/glossary/:term",
    { schema: { params: termParams, body: putGlossaryBody } },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "annotate");
      if (!resolved) return reply;
      const saved = await withLimitGuard(reply, () =>
        store.putGlossaryEntry(resolved.projectId, {
          entry: { term: req.params.term, meaning: req.body.meaning },
        }),
      );
      if (!saved) return reply;
      return { ...saved, updatedAt: saved.updatedAt.toISOString() };
    },
  );

  r.delete("/api/v1/glossary/:term", { schema: { params: termParams } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "annotate");
    if (!resolved) return reply;
    const deleted = await store.deleteGlossaryEntry(resolved.projectId, req.params.term);
    if (!deleted) return reply.code(404).send({ error: "term not defined" });
    return reply.code(204).send();
  });

  // --- Saved analyses ------------------------------------------------------

  r.get("/api/v1/analyses", { schema: { querystring: listQuery } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "query");
    if (!resolved) return reply;
    const rows = await store.listSavedAnalyses(resolved.projectId, req.query);
    return rows.map(toAnalysisBody);
  });

  r.post("/api/v1/analyses", { schema: { body: savedAnalysisSchema } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "annotate");
    if (!resolved) return reply;
    const created = await withLimitGuard(reply, () =>
      store.createSavedAnalysis(resolved.projectId, {
        analysis: req.body,
        authorKind: metadataAuthorKind(req),
        authorKeyId: resolved.keyId,
      }),
    );
    if (!created) return reply;
    return reply.code(201).send(toAnalysisBody(created));
  });

  r.delete("/api/v1/analyses/:id", { schema: { params: idParams } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "annotate");
    if (!resolved) return reply;
    const deleted = await store.deleteSavedAnalysis(resolved.projectId, req.params.id);
    if (!deleted) return reply.code(404).send({ error: "analysis not found" });
    return reply.code(204).send();
  });
};
