/**
 * The project **context document** — `GET /api/v1/context` (ADR 0051 §5, design
 * sketch §E.1).
 *
 * Agents start blind. They know the *shape* of the read surface from the metric
 * registry, but nothing about the project in front of them: what its scenes are
 * called, which regions have names, which capture channels are even on, what the
 * application calls its own events, whether raw retention is enabled, or how
 * fresh the data is. Every one of those is a guess an agent would otherwise make
 * badly — asking for `scene=lobby` when the scene is `main-hall`, reporting a
 * zero from a disabled channel as a finding, filtering on a custom event name
 * that does not exist.
 *
 * This route answers all of it in one read, assembled entirely from aggregates
 * and registry rows the collector already serves. It is:
 *
 * - **bounded** — every list is capped (see the `MAX_*` constants), so the whole
 *   document stays comfortably inside the budget a small local model can carry
 *   in its system prompt; `context.test.ts` asserts the fixture project's
 *   document is under 16 KB;
 * - **cached** — briefly, per project ({@link CONTEXT_CACHE_TTL_MS}), because an
 *   assistant re-reads it on every session start and it costs half a dozen
 *   aggregate queries to build;
 * - **read-only and aggregate-only** — no raw event, no session id, no prop
 *   value, nothing a caller could not already read through the query API
 *   (ADR 0003).
 *
 * It is deliberately **not** a registry metric: it is not an aggregation over
 * the event stream with a row grain, it is a description of the project. It is
 * described in the OpenAPI document by hand, alongside the other non-metric
 * routes (`routes/meta.ts`).
 */

import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { EVENT_TYPES, SCHEMA_VERSION, type EventType } from "@uptimizr/schema";
import { allMetrics } from "@uptimizr/metrics";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";
import { requireCapability } from "../auth.js";
import { COLLECTOR_VERSION } from "../version.js";
import { EMPTY_PROJECT_METADATA, type ProjectMetadataProvider } from "../projectMetadata.js";

export interface ContextRoutesOptions {
  store: CollectorStore;
  config: CollectorConfig;
  /**
   * Source of the glossary and recent annotations. Defaults to the empty
   * provider until the metadata write path exists (see `projectMetadata.ts`).
   */
  metadata?: ProjectMetadataProvider;
}

/** How long a built document is reused for the same project. */
export const CONTEXT_CACHE_TTL_MS = 30_000;

/** The activity window the vocabulary, scenes and channels are computed over. */
const CONTEXT_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
/** The freshness window `dataQuality` reports. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Caps that keep the document bounded whatever the project contains. */
const MAX_SCENES = 40;
const MAX_REGIONS_PER_SCENE = 20;
const MAX_CUSTOM_EVENTS = 25;
const MAX_TOP_MESHES = 10;
/** Distinct meshes counted before `vocabulary.meshes.count` saturates. */
const MAX_COUNTED_MESHES = 200;
const MAX_INPUT_ACTIONS = 25;
const MAX_ANNOTATIONS = 10;
const MAX_GLOSSARY = 50;

/** One named region of a scene: the vocabulary a `region=` filter resolves against. */
const regionSchema = z.object({
  id: z.string(),
  label: z.string(),
});

const sceneSchema = z.object({
  /** Developer-assigned scene id (ADR 0010) — the value of the `scene` filter. */
  id: z.string(),
  /** Display label from the scene registry, when one was registered. */
  label: z.string().nullable(),
  /** Named regions declared for this scene (ADR 0051 §2). */
  regions: z.array(regionSchema),
  /** Whether proxy geometry is registered, so spatial results can be labelled. */
  proxy: z.boolean(),
  /**
   * Events recorded in this scene over the context window.
   *
   * The design sketch asks for `sessions28d`; no aggregation reports distinct
   * sessions per scene, and inventing one is outside this change. Event volume
   * is the honest, already-served stand-in and is named for what it is.
   */
  events28d: z.number().int(),
});

const captureChannelSchema = z.object({
  /** Whether any event of this type was recorded over the context window. */
  seen: z.boolean(),
  /** Events of this type over the context window. Omitted when none were seen. */
  events28d: z.number().int().optional(),
});

const customEventSchema = z.object({
  name: z.string(),
  count28d: z.number().int(),
  sessions28d: z.number().int(),
  /** Observed `props` keys mapped to a coarse type. Never prop *values*. */
  props: z.record(z.string(), z.string()),
});

const glossarySchema = z.object({ term: z.string(), meaning: z.string() });

const annotationSchema = z.object({
  id: z.string(),
  target: z.object({ kind: z.string(), id: z.string().nullable() }),
  text: z.string(),
  at: z.number().int(),
});

/**
 * The context document. Declared as Zod so it validates on the way out like
 * every other response, and so the OpenAPI description in `meta.ts` and this
 * shape cannot drift apart silently.
 */
export const projectContextSchema = z.object({
  /** Identity of the project and of the software serving it. */
  project: z.object({
    id: z.string(),
    /** Storage engine behind this collector (`duckdb`, `clickhouse`, …). */
    store: z.string(),
    /** Event wire-format version (`@uptimizr/schema`). */
    schemaVersion: z.string(),
    /** Version of the running collector, or `unknown`. */
    collectorVersion: z.string(),
  }),
  /** How fresh and how busy the project is — read this before quoting a zero. */
  dataQuality: z.object({
    /** Most recent event, epoch ms, or `null` when the project has no data. */
    lastEventAt: z.number().int().nullable(),
    sessions24h: z.number().int(),
    events24h: z.number().int(),
    retention: z.object({
      /**
       * Whether raw per-session event retention is enabled (ADR 0003). When
       * `false` the session timeline / replay endpoint returns nothing — that is
       * configuration, not missing data.
       */
      rawSessions: z.boolean(),
    }),
  }),
  /** Which capture channels (ADR 0012) this project actually produces. */
  capture: z.object({
    channels: z.record(z.string(), captureChannelSchema),
  }),
  scenes: z.array(sceneSchema),
  vocabulary: z.object({
    customEvents: z.array(customEventSchema),
    meshes: z.object({
      /** Distinct interacted meshes observed, saturating at 200. */
      count: z.number().int(),
      /** The busiest mesh names, most-interacted first. */
      top: z.array(z.string()),
    }),
    /** Developer-bound input action labels (#75, ADR 0023). */
    inputActions: z.array(z.string()),
  }),
  definitions: z.object({
    /** Saved funnel definitions. Always empty: funnels are caller-authored (ADR 0038). */
    funnels: z.array(z.unknown()),
    /** Saved segment definitions. Always empty until the metadata write path exists. */
    segments: z.array(z.unknown()),
    glossary: z.array(glossarySchema),
  }),
  annotations: z.object({
    recent: z.array(annotationSchema),
  }),
  metrics: z.object({
    /** Registry ids this collector serves. */
    available: z.array(z.string()),
    /**
     * Metrics whose every capture channel was unseen over the window — they will
     * return empty, and that is a capture setting rather than a finding.
     */
    disabledByCapture: z.array(z.string()),
  }),
  /** The window the 28-day figures were computed over, epoch ms. */
  window: z.object({ since: z.number().int(), until: z.number().int() }),
  /** When this document was built, epoch ms. Respect the cache TTL. */
  generatedAt: z.number().int(),
});

/** The project context document, as the route serves it. */
export type ProjectContext = z.infer<typeof projectContextSchema>;

/** A cached document and the moment it stops being served. */
interface CacheEntry {
  expiresAt: number;
  document: ProjectContext;
}

/** Parse an engine-formatted timestamp into epoch ms, or `null`. */
function toEpochMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build the document for one project. Pure orchestration over the store: every
 * figure comes from an aggregate the collector already serves, so there is no
 * new SQL here beyond the custom-event vocabulary.
 */
async function buildContext(
  store: CollectorStore,
  config: CollectorConfig,
  metadata: ProjectMetadataProvider,
  projectId: string,
  now: number,
): Promise<ProjectContext> {
  const since = now - CONTEXT_WINDOW_MS;
  const window = { since, until: now };
  const recent = { since: now - RECENT_WINDOW_MS, until: now };

  const [
    channelCounts,
    recentChannelCounts,
    recentSessions,
    sceneRows,
    representations,
    regionRows,
    customEvents,
    meshRows,
    inputActionRows,
    glossary,
    annotations,
  ] = await Promise.all([
    store.eventTypeCounts(projectId, window),
    store.eventTypeCounts(projectId, recent),
    store.listSessions(projectId, { ...recent, limit: 1000 }),
    store.scenes(projectId, { ...window, limit: MAX_SCENES }),
    store.listSceneRepresentations(projectId),
    store.listSceneRegions(projectId),
    store.customEventVocabulary(projectId, { ...window, limit: MAX_CUSTOM_EVENTS }),
    store.topMeshes(projectId, { ...window, limit: MAX_COUNTED_MESHES }),
    store.topInputActions(projectId, { ...window, limit: MAX_INPUT_ACTIONS }),
    metadata.glossary(projectId),
    metadata.recentAnnotations(projectId, MAX_ANNOTATIONS),
  ]);

  const countByType = new Map(channelCounts.map((row) => [row.event_type, row.count]));
  const channels: Record<string, z.infer<typeof captureChannelSchema>> = {};
  for (const type of EVENT_TYPES) {
    const events = countByType.get(type) ?? 0;
    channels[type] = events > 0 ? { seen: true, events28d: events } : { seen: false };
  }

  const labelByScene = new Map(representations.map((rep) => [rep.sceneId, rep.label]));
  const proxyScenes = new Set(representations.map((rep) => rep.sceneId));
  const regionsByScene = new Map<string, { id: string; label: string }[]>();
  for (const region of regionRows) {
    const list = regionsByScene.get(region.sceneId) ?? [];
    if (list.length >= MAX_REGIONS_PER_SCENE) continue;
    list.push({ id: region.regionId, label: region.label });
    regionsByScene.set(region.sceneId, list);
  }

  const scenes = sceneRows.map((row) => ({
    id: row.scene_id,
    label: labelByScene.get(row.scene_id) ?? null,
    regions: regionsByScene.get(row.scene_id) ?? [],
    proxy: proxyScenes.has(row.scene_id),
    events28d: row.events,
  }));

  const lastEventAt = sceneRows.reduce<number | null>((latest, row) => {
    const seen = toEpochMs(row.last_seen);
    return seen != null && (latest == null || seen > latest) ? seen : latest;
  }, null);

  // A metric is "disabled by capture" when it declares source channels and NONE
  // of them produced an event over the window. Derived rollups declare no
  // channels and are never reported as disabled.
  const served = allMetrics().filter((metric) => metric.endpoint != null);
  const seen = (type: EventType): boolean => (countByType.get(type) ?? 0) > 0;
  const disabledByCapture = served
    .filter(
      (metric) => metric.sourceChannels.length > 0 && !metric.sourceChannels.some((c) => seen(c)),
    )
    .map((metric) => metric.id);

  return {
    project: {
      id: projectId,
      store: store.engine,
      schemaVersion: SCHEMA_VERSION,
      collectorVersion: COLLECTOR_VERSION,
    },
    dataQuality: {
      lastEventAt,
      sessions24h: recentSessions.length,
      events24h: recentChannelCounts.reduce((total, row) => total + row.count, 0),
      retention: { rawSessions: config.enableRawSessionRetention },
    },
    capture: { channels },
    scenes,
    vocabulary: {
      customEvents: customEvents.map((row) => ({
        name: row.name,
        count28d: row.count,
        sessions28d: row.sessions,
        props: row.props,
      })),
      meshes: {
        count: meshRows.length,
        top: meshRows.slice(0, MAX_TOP_MESHES).map((row) => row.mesh),
      },
      inputActions: [...new Set(inputActionRows.map((row) => row.action))].slice(
        0,
        MAX_INPUT_ACTIONS,
      ),
    },
    definitions: {
      funnels: [],
      segments: [],
      glossary: glossary.slice(0, MAX_GLOSSARY).map((entry) => ({ ...entry })),
    },
    annotations: {
      recent: annotations.slice(0, MAX_ANNOTATIONS).map((entry) => ({
        id: entry.id,
        target: { kind: entry.target.kind, id: entry.target.id },
        text: entry.text,
        at: entry.at,
      })),
    },
    metrics: {
      available: served.map((metric) => metric.id),
      disabledByCapture,
    },
    window,
    generatedAt: now,
  };
}

/**
 * The project context route. Registered as its own plugin so the query plugin —
 * which is the registry-metric surface, and is asserted against the registry
 * route by route — stays exactly that.
 */
export const contextRoutes: FastifyPluginAsync<ContextRoutesOptions> = async (
  app,
  { store, config, metadata = EMPTY_PROJECT_METADATA },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  /** Per-project document cache, cleared with the instance. */
  const cache = new Map<string, CacheEntry>();

  app.addHook("onClose", async () => cache.clear());

  r.get(
    "/api/v1/context",
    { schema: { response: { 200: projectContextSchema } } },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "query");
      if (!resolved) return reply;
      const projectId = resolved.projectId;

      const now = Date.now();
      const cached = cache.get(projectId);
      if (cached && cached.expiresAt > now) return cached.document;

      const document = await buildContext(store, config, metadata, projectId, now);
      cache.set(projectId, { expiresAt: now + CONTEXT_CACHE_TTL_MS, document });
      return document;
    },
  );
};
