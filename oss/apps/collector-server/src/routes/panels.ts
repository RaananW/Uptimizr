import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { panelSpecV1Schema, type PanelSpecV1 } from "@uptimizr/schema";
import { validatePanelSpec } from "@uptimizr/metrics";
import { MetadataLimitError, type PanelSpecRecord } from "@uptimizr/db";
import type { CollectorStore } from "../store.js";
import { metadataAuthorKind, requireCapability } from "../auth.js";

/**
 * **Declarative panel specs** (#315, ADR 0051 §7, design sketch §G.3): the
 * panels an agent pins to the dashboard when an answer is worth keeping.
 *
 * A fourth metadata surface beside `routes/metadata.ts`, with the same rules —
 * writes need `annotate`, reads need `query`, the project comes from the key,
 * every write is audited by the app-level hook, and the store bounds the row
 * count per project and answers `409` when it is full.
 *
 * ## Why a spec rather than a panel module
 *
 * ADR 0041 can load a *remote panel module* at runtime, and is explicit about
 * the cost: such a module runs with the dashboard's full privileges, which is
 * why it is off by default and guarded by an origin allowlist. A panel an LLM
 * wrote would be exactly that. So what is stored here is **data** — a metric
 * id, a chart name, some column names — and the dashboard renders it with the
 * panel components it already ships. Pinning a panel widens the dashboard's
 * trust boundary by nothing, and ADR 0041's decision is left where it is.
 *
 * ## Validated twice, for two different questions
 *
 * 1. `panelSpecV1Schema` (`@uptimizr/schema`) — is this a well-formed spec? A
 *    known chart name, bounded strings, a closed query grammar, no unknown keys.
 * 2. `validatePanelSpec` (`@uptimizr/metrics`) — will it *draw anything*? Does
 *    the metric exist and accept these filters, does the chart suit its grain,
 *    do the encoding columns exist in its result.
 *
 * The second is the one that matters here, and the reason it runs at pin time
 * rather than at render time: a pinned panel is read weeks after it is written,
 * and a line chart with no axis to walk along does not fail — it draws
 * *something*, which somebody then reads as a trend. The moment anybody is
 * paying attention is the moment the panel is pinned, so that is where the
 * refusal belongs. The rejection is `400 { error, issues }` — the same body
 * `POST /api/v1/query` answers with, carrying the validator's issue codes — so
 * a client can fix the spec from the response instead of guessing.
 */

interface Options {
  store: CollectorStore;
}

/** Generated row id in a path (`/panels/:id`). */
const idParams = z.object({ id: z.string().min(1).max(128) });

/** Row cap for the listing; the store's own cap is the real bound. */
const listQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

/** Wire shape of one stored panel row. */
function toPanelBody(row: PanelSpecRecord): Record<string, unknown> {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Run a metadata write and turn a full project into a `409` — the same guard
 * `routes/metadata.ts` uses, for the same reason: a cap breach is not a bad
 * request (the payload was fine) and not a server fault; it is a conflict with
 * the project's state that the caller fixes by unpinning something.
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

/**
 * Check a parsed spec against the metric registry, replying `400` with the
 * validator's issues when it cannot be drawn. Returns whether the spec passed,
 * so both the create and the replace path refuse identically.
 */
async function checkAgainstRegistry(reply: FastifyReply, spec: PanelSpecV1): Promise<boolean> {
  const { issues } = validatePanelSpec(spec);
  if (issues.length === 0) return true;
  await reply.code(400).send({
    error: `the panel cannot be pinned: ${issues[0]!.message}`,
    issues: issues.map((issue) => ({ ...issue })),
  });
  return false;
}

export const panelRoutes: FastifyPluginAsync<Options> = async (app, { store }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // The project's pinned panels, oldest first — these are grid positions, and
  // listing them newest-first would reshuffle the dashboard on every pin.
  r.get("/api/v1/panels", { schema: { querystring: listQuery } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "query");
    if (!resolved) return reply;
    const rows = await store.listPanelSpecs(resolved.projectId, req.query);
    return rows.map(toPanelBody);
  });

  r.post("/api/v1/panels", { schema: { body: panelSpecV1Schema } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "annotate");
    if (!resolved) return reply;
    if (!(await checkAgainstRegistry(reply, req.body))) return reply;
    const created = await withLimitGuard(reply, () =>
      store.createPanelSpec(resolved.projectId, {
        spec: req.body,
        authorKind: metadataAuthorKind(req),
        authorKeyId: resolved.keyId,
      }),
    );
    if (!created) return reply;
    return reply.code(201).send(toPanelBody(created));
  });

  // A full replacement rather than a patch: the spec is one closed document and
  // half of one is not a panel. The row keeps its id, its place in the grid and
  // its original authorship — an edit is not a new pin.
  r.put(
    "/api/v1/panels/:id",
    { schema: { params: idParams, body: panelSpecV1Schema } },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "annotate");
      if (!resolved) return reply;
      if (!(await checkAgainstRegistry(reply, req.body))) return reply;
      const updated = await store.updatePanelSpec(resolved.projectId, req.params.id, {
        spec: req.body,
      });
      if (!updated) return reply.code(404).send({ error: "panel not found" });
      return toPanelBody(updated);
    },
  );

  // 404 for an unknown id *and* for one that belongs to another project — the
  // two are deliberately indistinguishable, so an id cannot be probed across
  // projects.
  r.delete("/api/v1/panels/:id", { schema: { params: idParams } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "annotate");
    if (!resolved) return reply;
    const deleted = await store.deletePanelSpec(resolved.projectId, req.params.id);
    if (!deleted) return reply.code(404).send({ error: "panel not found" });
    return reply.code(204).send();
  });
};
