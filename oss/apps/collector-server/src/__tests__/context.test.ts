/**
 * The project context document — `GET /api/v1/context` (ADR 0051 §5, sketch §E.1).
 *
 * Boots the real app on a real in-memory DuckDB store seeded with the shared
 * parity fixtures, **shifted to now** so they fall inside the document's 28-day
 * and 24-hour windows, plus a scene proxy and a named region. The assertions are
 * the promises the document makes to an agent: it is authenticated and
 * project-scoped, it is bounded, it is cached, it names the scenes/regions and
 * the discovered vocabulary, it reports retention honestly, and it tells the
 * agent which metrics are empty because a capture channel is off rather than
 * because nothing happened.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AnyEvent } from "@uptimizr/schema";
import { PARITY_EVENTS, PARITY_PROJECT_ID, PARITY_T0 } from "@uptimizr/db";
import { buildApp } from "../app.js";
import { createDuckdbStore } from "../duckdbStore.js";
import type { CollectorStore } from "../store.js";
import type { ProjectContext } from "../routes/context.js";
import type { ProjectMetadataProvider } from "../projectMetadata.js";
import { TEST_CONFIG, TEST_PROXY } from "./support/registryRequests.js";

const API_KEY = "context-key";
const OTHER_KEY = "ingest-only-key";

/** The parity fixtures, moved forward so they sit a minute or so in the past. */
function recentEvents(): AnyEvent[] {
  const shift = Date.now() - 60_000 - PARITY_T0;
  return PARITY_EVENTS.map((event) => ({ ...event, ts: event.ts + shift }) as AnyEvent);
}

async function buildTestApp(
  options: {
    metadata?: ProjectMetadataProvider;
    enableRawSessionRetention?: boolean;
    /** Runs against the seeded store before the app is built. */
    seed?: (store: CollectorStore) => Promise<void>;
  } = {},
): Promise<FastifyInstance> {
  const base = await createDuckdbStore(":memory:");
  await base.insertEvents(recentEvents());
  await base.putSceneProxy(PARITY_PROJECT_ID, TEST_PROXY, "Main Lobby");
  await base.putSceneRegions(PARITY_PROJECT_ID, "lobby", [
    { id: "counter", label: "Checkout counter", bounds: [-1, 0, -1, 1, 2, 1] },
  ]);
  await options.seed?.(base);
  const store: CollectorStore = {
    ...base,
    resolveApiKey: async (key) => {
      if (key === API_KEY) {
        return {
          projectId: PARITY_PROJECT_ID,
          keyId: "context-key-id",
          capabilities: ["query"],
          label: "context test",
          rateLimit: null,
        };
      }
      if (key === OTHER_KEY) {
        return {
          projectId: PARITY_PROJECT_ID,
          keyId: "ingest-key-id",
          capabilities: ["ingest"],
          label: "ingest only",
          rateLimit: null,
        };
      }
      return null;
    },
  };
  const app = await buildApp({
    store,
    config: {
      ...TEST_CONFIG,
      enableRawSessionRetention: options.enableRawSessionRetention ?? false,
    },
    projectMetadata: options.metadata,
  });
  await app.ready();
  return app;
}

async function readContext(app: FastifyInstance, key = API_KEY): Promise<ProjectContext> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/context",
    headers: { "x-api-key": key },
  });
  expect(response.statusCode, response.body.slice(0, 400)).toBe(200);
  return response.json() as ProjectContext;
}

describe("GET /api/v1/context", () => {
  let app: FastifyInstance;
  let context: ProjectContext;

  beforeAll(async () => {
    app = await buildTestApp();
    context = await readContext(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("requires a query-capable key", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/context" })).statusCode).toBe(401);
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/context",
      headers: { "x-api-key": OTHER_KEY },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("identifies the project, the store engine and the running software", () => {
    expect(context.project.id).toBe(PARITY_PROJECT_ID);
    expect(context.project.store).toBe("duckdb");
    expect(context.project.schemaVersion).toBe("1.0");
    expect(context.project.collectorVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reports freshness and the retention flag", async () => {
    expect(context.dataQuality.lastEventAt).toBeGreaterThan(Date.now() - 10 * 60_000);
    expect(context.dataQuality.sessions24h).toBe(2);
    expect(context.dataQuality.events24h).toBe(PARITY_EVENTS.length);
    expect(context.dataQuality.retention.rawSessions).toBe(false);

    const retained = await buildTestApp({ enableRawSessionRetention: true });
    try {
      const withRetention = await readContext(retained);
      expect(withRetention.dataQuality.retention.rawSessions).toBe(true);
    } finally {
      await retained.close();
    }
  });

  it("marks a capture channel seen only when it produced events", () => {
    expect(context.capture.channels.camera_sample).toEqual({ seen: true, events28d: 3 });
    // No `input_action` in the parity fixtures — an honest "not captured here".
    expect(context.capture.channels.input_action).toEqual({ seen: false });
    // Every canonical event type is reported, so absence is never ambiguous.
    expect(Object.keys(context.capture.channels).length).toBeGreaterThan(20);
  });

  it("names the scenes with their labels, regions and proxy flag", () => {
    const lobby = context.scenes.find((scene) => scene.id === "lobby");
    const arena = context.scenes.find((scene) => scene.id === "arena");

    expect(lobby).toMatchObject({
      id: "lobby",
      label: "Main Lobby",
      proxy: true,
      regions: [{ id: "counter", label: "Checkout counter" }],
    });
    expect(lobby!.events28d).toBeGreaterThan(0);
    expect(arena).toMatchObject({ label: null, proxy: false, regions: [] });
  });

  it("discovers the custom-event vocabulary, meshes and input actions", () => {
    expect(context.vocabulary.customEvents).toEqual([
      {
        name: "add_to_cart",
        count28d: 3,
        sessions28d: 2,
        props: { sku: "string", qty: "number", gift: "boolean" },
      },
      { name: "level_complete", count28d: 1, sessions28d: 1, props: { level: "number" } },
    ]);
    expect(context.vocabulary.meshes.count).toBeGreaterThan(0);
    expect(context.vocabulary.meshes.top.length).toBeLessThanOrEqual(10);
    // No `input_action` fixtures, so the list is empty rather than invented.
    expect(context.vocabulary.inputActions).toEqual([]);
  });

  it("never reports a custom prop value, only its key and kind", () => {
    const serialised = JSON.stringify(context);
    // `box-1` / `box-2` are the `sku` values the fixtures send.
    expect(serialised).not.toContain("box-1");
    expect(serialised).not.toContain("box-2");
  });

  it("separates metrics that are available from metrics with no capture", () => {
    expect(context.metrics.available).toContain("custom_event_vocabulary");
    expect(context.metrics.available).toContain("top_meshes");
    // `input_action` produced nothing, so its leaderboard cannot.
    expect(context.metrics.disabledByCapture).toContain("top_input_actions");
    expect(context.metrics.disabledByCapture).not.toContain("custom_event_vocabulary");
    // Nothing is in both lists' intersection by accident.
    for (const id of context.metrics.disabledByCapture) {
      expect(context.metrics.available).toContain(id);
    }
  });

  it("carries empty definitions and annotations without a metadata provider", () => {
    expect(context.definitions).toEqual({ funnels: [], segments: [], glossary: [] });
    expect(context.annotations).toEqual({ recent: [] });
  });

  it("includes the glossary and annotations a metadata provider supplies", async () => {
    const metadata: ProjectMetadataProvider = {
      glossary: async () => [{ term: "btn_01", meaning: "the buy button" }],
      recentAnnotations: async () => [
        {
          id: "a1",
          target: { kind: "scene", id: "lobby" },
          text: "Launch of v2 lobby",
          at: 1_757_400_000_000,
        },
      ],
    };
    const withMetadata = await buildTestApp({ metadata });
    try {
      const document = await readContext(withMetadata);
      expect(document.definitions.glossary).toEqual([
        { term: "btn_01", meaning: "the buy button" },
      ]);
      expect(document.annotations.recent).toHaveLength(1);
      expect(document.annotations.recent[0]!.text).toBe("Launch of v2 lobby");
    } finally {
      await withMetadata.close();
    }
  });

  it("reads the glossary and annotations the metadata store holds (#310)", async () => {
    // The default provider is no longer the empty one: `buildApp` wires the
    // metadata write path's own `listGlossary` / `listAnnotations` into the
    // context document, so a term written through `PUT /api/v1/glossary/:term`
    // shows up here without the route, the schema or any client changing.
    const withStore = await buildTestApp({
      seed: async (store) => {
        await store.putGlossaryEntry(PARITY_PROJECT_ID, {
          entry: { term: "btn_01", meaning: "the buy button" },
        });
        await store.createAnnotation(PARITY_PROJECT_ID, {
          authorKind: "agent",
          authorKeyId: "context-key-id",
          annotation: { targetKind: "scene", targetId: "lobby", text: "Launch of v2 lobby" },
        });
      },
    });
    try {
      const document = await readContext(withStore);
      expect(document.definitions.glossary).toEqual([
        { term: "btn_01", meaning: "the buy button" },
      ]);
      expect(document.annotations.recent).toHaveLength(1);
      expect(document.annotations.recent[0]).toMatchObject({
        target: { kind: "scene", id: "lobby" },
        text: "Launch of v2 lobby",
      });
      expect(typeof document.annotations.recent[0]!.at).toBe("number");
    } finally {
      await withStore.close();
    }
  });

  it("stays under 16 KB for the fixture project", () => {
    const bytes = Buffer.byteLength(JSON.stringify(context), "utf8");
    expect(bytes, `context document is ${bytes} bytes`).toBeLessThan(16 * 1024);
  });

  it("serves a cached document for repeat reads of the same project", async () => {
    const first = await readContext(app);
    const second = await readContext(app);
    // Same `generatedAt` ⇒ the second read did not rebuild the document.
    expect(second.generatedAt).toBe(first.generatedAt);
  });
});
