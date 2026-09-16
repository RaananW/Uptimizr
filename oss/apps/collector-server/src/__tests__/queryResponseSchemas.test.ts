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
import { allMetrics, type MetricDefinition } from "@uptimizr/metrics";
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
 * Wrap a store so every method's return value is recorded. The recorded value is
 * what the handler saw; the response body is what survived serialisation.
 */
function recordingStore(store: CollectorStore, sink: { last: unknown }): CollectorStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
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

const METRICS_WITH_ENDPOINTS = allMetrics().filter((metric) => metric.endpoint != null);

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
      resolveApiKey: async (key) => (key === API_KEY ? { projectId, capability: "query" } : null),
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
      expectNothingStripped(metric.id, sink.last, body);
      expectNumbersOnTheWire(metric, body);
    });
  }
});
