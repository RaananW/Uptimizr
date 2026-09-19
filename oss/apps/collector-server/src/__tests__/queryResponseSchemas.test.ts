/**
 * Response-schema contract for every registry endpoint (ADR 0051 §1 / §2).
 *
 * `routes/query.ts` attaches each metric's registry `row` as the route's 200
 * response schema, so the Zod type provider serialises through it. That buys a
 * documented, generatable output shape — and two failure modes that must be
 * caught here rather than in a dashboard:
 *
 * 1. **Stripping.** `z.object()` drops keys it does not declare. If a handler
 *    returns a column the registry does not describe, it silently disappears
 *    from the response. Every request below runs through a recording store, and
 *    the serialised body is compared against what the store actually returned:
 *    every key, with an equal value, must survive.
 * 2. **Strictness.** Serialisation validates, so a `null` in a column declared
 *    non-nullable, or a *string* in a numeric one, is a 500. SQL aggregates are
 *    `NULL` over an empty set, so the surface is exercised against a **seeded**
 *    project and an **empty** one — the shape a brand-new collector returns.
 *
 * The third scenario runs the same sweep against the collector's **in-memory**
 * store, which builds its rows in JavaScript rather than SQL. It is what the
 * playground E2E harness boots, so its rows have to satisfy the same registry
 * contract as the SQL stores (ADR 0051 §2); this is where a drift between a
 * hand-built row and its registry entry surfaces.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PARITY_EVENTS, PARITY_PROJECT_ID, numericColumns } from "@uptimizr/db";
import {
  allMetrics,
  isDerivedMetric,
  metricCapability,
  type MetricDefinition,
} from "@uptimizr/metrics";
import type { AnyEvent } from "@uptimizr/schema";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { createDuckdbStore } from "../duckdbStore.js";
import { createMemoryStore } from "../memoryStore.js";
import type { CollectorStore } from "../store.js";
import {
  requestUrl,
  RESOURCE_METRICS,
  TEST_CONFIG as config,
  TEST_PROXY as PROXY,
} from "./support/registryRequests.js";

const API_KEY = "response-schema-key";
const EMPTY_PROJECT_ID = "00000000-0000-4000-8000-000000000000";

/**
 * Store methods that are **not** on the request path and must never land in the
 * sink. The agent audit log (#309) writes from a fire-and-forget `onResponse`
 * hook and the retention sweep runs on a timer, so either could resolve after
 * the handler did and overwrite the value the assertions are about to read.
 */
const OFF_REQUEST_PATH = new Set(["recordAudit", "pruneAudit"]);

/**
 * Wrap a store so every method's return value is recorded. The recorded value is
 * what the handler saw; the response body is what survived serialisation.
 */
function recordingStore(store: CollectorStore, sink: { last: unknown }): CollectorStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (typeof property === "string" && OFF_REQUEST_PATH.has(property)) {
        return (...args: unknown[]): unknown =>
          (value as (...a: unknown[]) => unknown).apply(target, args);
      }
      return async (...args: unknown[]) => {
        const result: unknown = await (value as (...a: unknown[]) => unknown).apply(target, args);
        sink.last = result;
        return result;
      };
    },
  }) as CollectorStore;
}

/**
 * Every key the store returned must still be present, with an equal value, in
 * the serialised body. Extra keys on the response are fine — the three spatial
 * `stats` routes add the resolved `cellSize`.
 */
function expectNothingStripped(metricId: string, produced: unknown, body: unknown): void {
  const rawRows = Array.isArray(produced) ? produced : produced == null ? [] : [produced];
  const bodyRows = Array.isArray(body) ? body : body == null ? [] : [body];
  expect(bodyRows.length, `${metricId}: row count changed by serialisation`).toBe(rawRows.length);
  for (let i = 0; i < rawRows.length; i++) {
    const raw = JSON.parse(JSON.stringify(rawRows[i])) as Record<string, unknown>;
    const serialised = bodyRows[i] as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      expect(
        Object.prototype.hasOwnProperty.call(serialised, key),
        `${metricId}: response schema stripped the "${key}" column`,
      ).toBe(true);
      expect(serialised[key], `${metricId}: "${key}" changed during serialisation`).toEqual(value);
    }
  }
}

/**
 * Every row on the wire carries exactly the columns the registry declares.
 *
 * The stripping check for a **derived** metric, whose rows are computed in
 * TypeScript rather than returned by the store. A missing key means the response
 * schema dropped a column the handler produced; an extra one means the handler
 * produced something the registry does not describe (which serialisation would
 * then drop, so it cannot actually appear — asserting both keeps the failure
 * message honest whichever way the drift goes).
 */
function expectDeclaredColumns(metric: MetricDefinition, body: unknown): void {
  const rows = Array.isArray(body) ? body : body == null ? [] : [body];
  const declared = Object.keys(metric.columns).sort();
  for (const row of rows as Record<string, unknown>[]) {
    expect(Object.keys(row).sort(), `${metric.id}: row columns drifted from the registry`).toEqual(
      declared,
    );
  }
}

/** Every numeric column the registry declares must be a number on the wire. */
function expectNumbersOnTheWire(metric: MetricDefinition, body: unknown): void {
  const rows = Array.isArray(body) ? body : body == null ? [] : [body];
  const numeric = numericColumns(metric.row);
  for (const row of rows as Record<string, unknown>[]) {
    for (const column of numeric) {
      const value = row[column];
      if (value === undefined || value === null) continue;
      expect(typeof value, `${metric.id}.${column} reached the wire as ${typeof value}`).toBe(
        "number",
      );
    }
  }
}

/**
 * Every endpoint this sweep can call with an ordinary `query` key.
 *
 * `session_narrative` is excluded: it needs `ENABLE_RAW_SESSION_RETENTION` and a
 * `query:raw` key (ADR 0051 §7), so the sweep would only ever see its 403. It
 * also declares no 200 response schema — the narrative is computed in memory by
 * `buildSessionNarrative` rather than projected out of a store row, so there is
 * no serialisation seam for this suite to guard. `narrative.test.ts` covers it
 * against the full gate matrix instead.
 */
const METRICS_WITH_ENDPOINTS = allMetrics().filter(
  (metric) => metric.endpoint != null && metricCapability(metric) === "query",
);

interface Scenario {
  label: string;
  /** Build the backing store and the project id its API key resolves to. */
  make: () => Promise<{ store: CollectorStore; projectId: string }>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    label: "duckdb store, seeded project",
    make: async () => {
      const store = await createDuckdbStore(":memory:");
      await store.insertEvents(PARITY_EVENTS);
      await store.putSceneProxy(PARITY_PROJECT_ID, PROXY, "Main Lobby");
      return { store, projectId: PARITY_PROJECT_ID };
    },
  },
  {
    label: "duckdb store, empty project",
    make: async () => ({
      store: await createDuckdbStore(":memory:"),
      projectId: EMPTY_PROJECT_ID,
    }),
  },
  {
    label: "in-memory store",
    make: async () => {
      const store = createMemoryStore({ projectId: PARITY_PROJECT_ID, apiKey: API_KEY });
      await store.insertEvents(PARITY_EVENTS);
      await store.putSceneProxy(PARITY_PROJECT_ID, PROXY, "Main Lobby");
      return { store, projectId: PARITY_PROJECT_ID };
    },
  },
];

describe.each(SCENARIOS)("query response schemas — $label", (scenario) => {
  let app: FastifyInstance;
  const sink: { last: unknown } = { last: undefined };

  beforeAll(async () => {
    const { store: base, projectId } = await scenario.make();
    const store: CollectorStore = {
      ...recordingStore(base, sink),
      resolveApiKey: async (key) =>
        key === API_KEY
          ? {
              projectId,
              keyId: "query-response-schemas-key-id",
              capabilities: ["query"],
              label: null,
              rateLimit: null,
            }
          : null,
    };
    app = await buildApp({ store, config });
  });

  afterAll(async () => {
    await app?.close();
  });

  it(`covers every registry endpoint (${METRICS_WITH_ENDPOINTS.length})`, () => {
    expect(METRICS_WITH_ENDPOINTS.length).toBeGreaterThan(60);
  });

  for (const metric of METRICS_WITH_ENDPOINTS) {
    it(`serialises ${metric.id} without stripping or rejecting a column`, async () => {
      sink.last = undefined;
      const response = await app.inject({
        method: "GET",
        url: requestUrl(metric),
        headers: { "x-api-key": API_KEY },
      });

      // A resource read of something that was never registered is a legitimate 404.
      if (response.statusCode === 404 && RESOURCE_METRICS.has(metric.id)) return;

      expect(
        response.statusCode,
        `${metric.id} → ${response.statusCode}: ${response.body.slice(0, 500)}`,
      ).toBe(200);
      const body: unknown = response.json();
      // A **derived** metric (the insight primitives, ADR 0051 §4) does not
      // return what the store returned: its handler reads a *bucket series* and
      // computes the row in TypeScript, so the recorded store result is the
      // wrong thing to diff the body against. The stripping risk is identical
      // though — a column the registry does not describe would silently vanish —
      // so it is checked directly instead.
      if (isDerivedMetric(metric)) expectDeclaredColumns(metric, body);
      else expectNothingStripped(metric.id, sink.last, body);
      expectNumbersOnTheWire(metric, body);
    });
  }
});

/**
 * Regression for the event-volume panel's 500 (#367 fallout): a bucket that
 * holds traffic but **no** `frame_perf` sample.
 *
 * The sweep above seeds every fixture event into a single 60 s bucket, so
 * `timeseries.avg_fps` was only ever exercised with samples in it. On a real
 * collector most minutes have events and no perf telemetry, so `avg` is
 * SQL-NULL there — and the registry declared the column non-nullable, which
 * made the Zod serialiser reject the row with a 500. The dashboard's
 * event-volume panel then rendered "Could not load" instead of its bars, and
 * with it went the annotation markers on the time axis.
 *
 * Both stores are checked: the SQL one, whose NULL comes from the engine, and
 * the in-memory one, which builds the row in JavaScript and used to 0-fill it.
 */
describe("timeseries: a bucket with events but no perf samples", () => {
  const PROJECT_ID = "no-perf-bucket-project";
  const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
  /** Five minutes later — its own 60 s bucket, and nothing perf-ish in it. */
  const LATER = T0 + 5 * 60_000;

  function ev(type: string, ts: number, extra: Record<string, unknown> = {}): AnyEvent {
    return {
      type,
      projectId: PROJECT_ID,
      sessionId: "s1",
      ts,
      sdkVersion: "0.1.0",
      sceneId: "lobby",
      ...extra,
    } as AnyEvent;
  }

  const EVENTS: AnyEvent[] = [
    ev("session_start", T0),
    ev("frame_perf", T0 + 1_000, { fps: 60, frameMs: 16.7 }),
    // The bucket that broke it: clicks, no `frame_perf`.
    ev("pointer_click", LATER, { mesh: "box" }),
    ev("pointer_click", LATER + 1_000, { mesh: "box" }),
  ];

  const url = `/api/v1/timeseries?since=${T0 - 60_000}&until=${LATER + 60_000}&interval=60`;

  const stores: readonly { label: string; make: () => Promise<CollectorStore> }[] = [
    {
      label: "duckdb store",
      make: async () => {
        const store = await createDuckdbStore(":memory:");
        await store.insertEvents(EVENTS);
        return store;
      },
    },
    {
      label: "in-memory store",
      make: async () => {
        const store = createMemoryStore({ projectId: PROJECT_ID, apiKey: API_KEY });
        await store.insertEvents(EVENTS);
        return store;
      },
    },
  ];

  for (const { label, make } of stores) {
    it(`serialises the perf-less bucket as null rather than 500ing (${label})`, async () => {
      const base = await make();
      const store: CollectorStore = {
        ...base,
        resolveApiKey: async (key) =>
          key === API_KEY
            ? {
                projectId: PROJECT_ID,
                keyId: "no-perf-bucket-key-id",
                capabilities: ["query"],
                label: null,
                rateLimit: null,
              }
            : null,
      };
      const app = await buildApp({ store, config });
      try {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { "x-api-key": API_KEY },
        });
        expect(response.statusCode, response.body.slice(0, 500)).toBe(200);

        const rows = response.json() as {
          bucket: number;
          events: number;
          avg_fps: number | null;
        }[];
        const withPerf = rows.find((row) => row.bucket === T0);
        const withoutPerf = rows.find((row) => row.bucket === LATER);
        expect(withPerf?.avg_fps).toBe(60);
        // Absent, not zero: nothing in this minute reported an FPS at all.
        expect(withoutPerf).toBeDefined();
        expect(withoutPerf!.events).toBe(2);
        expect(withoutPerf!.avg_fps).toBeNull();
      } finally {
        await app.close();
      }
    });
  }
});
