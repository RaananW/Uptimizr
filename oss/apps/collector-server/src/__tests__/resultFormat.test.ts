/**
 * `format=full | table | summary` across the whole query surface (ADR 0051 §2,
 * design sketch §B.1).
 *
 * The feature's central promise is a negative one: **`full` did not change.**
 * The dashboard never sends `format`, so if the default response drifted the
 * feature would have broken the product it was meant to leave alone. Three
 * assertions defend that, over the parity fixtures:
 *
 * - the default body still deep-equals exactly what the store handed the
 *   handler, key for key — the hook did not touch the payload;
 * - the default response and `format=full` carry the same rows;
 * - both hash to {@link PRE_CHANGE_BODY_HASHES} — the SHA-256 of the same
 *   request's body on the commit **before** this feature existed, recorded once
 *   and checked in. A response schema widened to a union, or a hook that touches
 *   a payload it should not, fails here.
 *
 * The hashes are taken over a **canonical** form of the body (rows sorted, keys
 * sorted) rather than the raw bytes, because DuckDB does not promise a stable
 * order between tied rows: two identical requests can legitimately return the
 * same rows in a different sequence. Canonicalising keeps the comparison honest
 * about content — which is what "unchanged" has to mean here — without pinning
 * an order the engine never guaranteed.
 *
 * The rest of the suite is the positive half: every registry endpoint accepts
 * the parameter, `table` and `summary` come back in their declared shapes (they
 * are serialised through the union response schema, so a shape the schema does
 * not describe would arrive stripped or as a 500), the summary is bounded by the
 * registry cap, and an unknown `format` is a 400 rather than a surprise.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PARITY_EVENTS, PARITY_PROJECT_ID } from "@uptimizr/db";
import { resultSummarySchema, tableResultSchema } from "@uptimizr/db";
import {
  allMetrics,
  isAggregateMetric,
  isDerivedMetric,
  type MetricDefinition,
} from "@uptimizr/metrics";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildApp } from "../app.js";
import { createDuckdbStore } from "../duckdbStore.js";
import type { CollectorStore } from "../store.js";
import {
  requestUrl,
  RESOURCE_METRICS,
  TEST_CONFIG as config,
  TEST_PROXY as PROXY,
} from "./support/registryRequests.js";

const API_KEY = "result-format-key";

/**
 * Store methods that are **not** on the request path and must never land in the
 * sink. The agent audit log (#309) writes from a fire-and-forget `onResponse`
 * hook and the retention sweep runs on a timer, so either could resolve after
 * the handler did and overwrite the value the assertions are about to read.
 */
const OFF_REQUEST_PATH = new Set(["recordAudit", "pruneAudit"]);

/**
 * SHA-256 of each endpoint's canonicalised response body over the parity
 * fixtures, recorded on `feat/store-edge-coercion` — the commit this change is
 * stacked on, before `format` existed.
 *
 * Regenerate **only** when a deliberate change to an endpoint's rows lands, and
 * never to make this suite pass: run the file with `RECORD_FULL_HASHES=1` and
 * paste what it prints.
 */
const PRE_CHANGE_BODY_HASHES: Readonly<Record<string, string>> = {
  // The two derived insight metrics (ADR 0051 §4) are recorded at their
  // introduction rather than before it: they had no prior body to preserve, but
  // from here their default shape is pinned like every other endpoint.
  "/api/v1/insights/baseline": "70da6e75dbce179a14e5ba83ac7f5db3f33dbaf1e15dd0a451d1695587f9aca2",
  "/api/v1/insights/movers": "db847696207abb389e259c5a7af2c40a3ac787cd8f47871dab46b3e73628038b",
  // --- significance / scene health (#307) --- recorded at their introduction,
  // for the same reason.
  "/api/v1/insights/significance":
    "227f0bb52db602021e4f66c1d295df9f9f9f264aa3a0df8e552fe17e2444d185",
  "/api/v1/insights/scene-health":
    "6fb945092acfa1715825c93e450bde028992bf6d8a045873675f071b0216f2b1",
  "/api/v1/sessions": "fc8a8b1690f001672de3e9dd0b336eb9c874ad55555577cfd9b9402358b326cd",
  "/api/v1/scenes": "7aba7bfa05c14a726c4667868c75e8f053c4fb2b0c8dedf6a775a58ef3bd556a",
  "/api/v1/timeseries": "956599592dac1cf3753392d03d113b7657687f12a2080ebad6822a87a2b63162",
  "/api/v1/event-counts": "8c1e75a0534531549e14c563095eaf0b817406fe1dc64783a07b931c70ddae8a",
  "/api/v1/heatmaps/pointer": "4e41b09f637099b7874362a800709ebe0800390d1ac9a1c8273a1eca8d7f73cc",
  "/api/v1/heatmaps/mesh-uv": "fed9cd3d814b12e31be8a44eb7fb5ad85332483c2ca58178e719ebde0978e7d4",
  "/api/v1/heatmaps/world": "89f03d861421299140a925be6af2af825df7bef49b9deecf7d23d85c8c37b994",
  "/api/v1/heatmaps/world/stats":
    "1771b1a27f7ed84d386518df9ac195cb44c952f92f5690d9161a166b745de4ce",
  "/api/v1/heatmaps/gaze": "bc285b362ca1191ae99389b525c760787d0a50c8951490483bf0f09d48490633",
  "/api/v1/heatmaps/gaze/stats": "2d810b74b4c81008752efff89fb10ba9d9325af26628c7637ea17e10d754db27",
  "/api/v1/heatmaps/camera": "9067e458723ef1e59c256d918f92682be3ff6554eb9712af5f530033febc3081",
  "/api/v1/coverage/view-histogram":
    "910ab68cf6628cc98bac0d4d2278233d29521d4d3f762bc74c77f1a29df25029",
  "/api/v1/heatmaps/position": "d5347cff35c1207bd224ebe224f0edef4beabc0a10be7fbafb98b20835d8eb47",
  "/api/v1/sessions/:sessionId/trajectory":
    "c7d4fe86bbe4c22adfabd9d8b18e9d376b7b26321fe91eae17ff6c968a935be9",
  "/api/v1/paths": "6d53ea2e3e233238b300a84b0739dc4d82168cd683dc8493dfeacb0558082b47",
  "/api/v1/coverage": "761fc3c8ca73302e1a9e340ae393529af8d43805ea9d683d032cc1171864fd65",
  "/api/v1/camera/distance": "2a5a68aecc22bfa2b4b1f8613bc966c65445533a45cd1bb5fa8eb7b82816937c",
  "/api/v1/heatmaps/click-rays": "171079bd2b0a183f3e25586a017948a8b146b2269c9b4f29d05da21f30e79614",
  "/api/v1/heatmaps/flow": "9a6d9fa4fe597045156b7d1fb76a33606c7f0eb7d9cf48d8ba2fa8ab9695a790",
  "/api/v1/meshes/top": "3d560cf828612c2c8aa5122326d0f55dba70658103a156b476615a36fcbc28c3",
  "/api/v1/meshes/sources": "9e57ba375e66d5946f6cfb4661331a5b53803ffd2d5a648d2701065ef69578c1",
  "/api/v1/meshes/trend": "118cff69371743332ec2a44b1a1a715498f421d85826f7a40d1b238de2311742",
  "/api/v1/meshes/dwell": "ac22ae4d270335ae95722d5776a88c2deb548404ac0c49d21655723b44206c55",
  "/api/v1/meshes/blind-spots": "fab577cbe1568659f1502b15b324d056689fcd2c599bc87d2c98e5483a777f76",
  "/api/v1/meshes/kinds": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/meshes/reachability": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/clicks/dead": "caac2f9a4451efab2a806c2426f4036be03e85dc80b9fbb5d8a413aa62af33d3",
  "/api/v1/clicks/rage": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/hover/dwell": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/interactions/sources":
    "6d12b16842ccf65d82adb39a830acb6f904e8c7aba2a1dece08317ee6a4133d9",
  "/api/v1/input-actions/top": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/camera-gestures": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/navigation": "0a7404cf407ff7a9613f4587da8c866d03db622840254b63718ea4ee211842ed",
  "/api/v1/backtrack": "08ad5ab26308da563768b12ede03b9f537b2bce493f34a375d3645b02311aa71",
  "/api/v1/perf": "537356f7b0301d02527b97be5fa6acb7efa4ec20cc071bc45d2d24dd32dfc460",
  "/api/v1/perf/render-scale": "05b16434b8eb62b13a396c2bfcd5704f5b848e2cb8cd6bb9b0b26685bd7284e0",
  "/api/v1/perf/distribution": "7d202d6fca37900a36969332eded9714031fb7c77ca5542d3a0d3787b093b271",
  "/api/v1/perf/fps-histogram": "304335924e9b874a2f101f9e3647bc846d90f2c58d2720e4a33616a23e4f42ff",
  "/api/v1/perf/frame-time": "ce06a1ce8e307cd41fea5a383e94d6be3055acc96a5afba9526fbe0258fb6392",
  "/api/v1/perf/jank": "f15771998b6f4647e0334ffffe9c254761375f28312f0910d1e3a44fd84ddfa2",
  "/api/v1/perf/churn": "6ee2ec64e152c25b3a0064349d0ca09ed4b67fe107d35ef6117f7bb1ae1ae1fe",
  "/api/v1/perf/by-device": "a1890c4c8cb0ff48fc81f32a217fa56f13ec1de2cdccc93e8b63ab95eb774888",
  "/api/v1/perf/by-scene": "dd4fbe66de285678bc18fa40a279f6951548b1beca1bf0cc1e4bb84112ffcf04",
  "/api/v1/heatmaps/perf": "f638b6f0f5b7c0f6ec6547620cdfb3099cd5b4a9d891fe4127f0eed431ac6595",
  "/api/v1/perf/compile-stalls": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/perf/resources": "300c51032b9bf9adbba30ccd90faea390bb3deebd25fa090f03961f6ba84aaac",
  "/api/v1/perf/resource-percentiles":
    "35ad8006de0431f1641d7623b7170cf93b0894bdb9bd8011eb269acab96d9252",
  "/api/v1/perf/stability": "917e02a80793f8ccc694e3c01a170dcb1d895b3555e2f47bd08e3c2476d64f39",
  "/api/v1/graphics-diagnostics":
    "c4a4a8c6f78f933e498a493d717f65517929d485abb33fbaf63dbbe167b91a4f",
  "/api/v1/heatmaps/errors": "b3260fccc41718cb574ea87cedea11c9277181f425a1ebc0967cd24f8ef2823d",
  "/api/v1/rendering-technology":
    "bc88e23f4d4a7c9185324143c4db501f6860ca44afb44e539f5ca3663847fbe0",
  "/api/v1/capabilities": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/xr/rotation": "3bd1b163faf93fef42c56cc558d0e66388b742d7f340fe38d6377e38e262b733",
  "/api/v1/xr/sources": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/xr/abandonment": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/xr/locomotion": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/xr/tracking": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/heatmaps/boundary": "eb946eae71ba23b261da0a9a46a2cf8218fc741310d84c2da59886835824748b",
  "/api/v1/heatmaps/boundary/stats":
    "c31d96684e5f9ec4d1d2b75382516aa30a488cb2a70c797aa79781cd810b02fa",
  "/api/v1/xr/boundary-contacts":
    "d8af5e86b052b2e915e171148fe29deef92eb97651c9ce9002affb992dda0f23",
  "/api/v1/ar/placement/time-to-place":
    "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/ar/placement/attempts":
    "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/ar/placement/surfaces":
    "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/funnel": "18a8f8d9fe53647be921f7e1a331ce86e3cea0ea6f8037245a484005c323d8bf",
  "/api/v1/scene-retention": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/load-bounce": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "/api/v1/variant-leaderboard": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
};

/** Recursively sort object keys, so two equal bodies render identically. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
}

/**
 * A response body reduced to its content: rows with sorted keys, themselves
 * sorted. Two responses with the same rows in a different order — which DuckDB
 * is free to produce for tied rows — canonicalise identically.
 */
function canonicalBody(value: unknown): string {
  const rows = Array.isArray(value) ? value : value == null ? [] : [value];
  return JSON.stringify(rows.map((row) => JSON.stringify(stable(row))).sort());
}

/**
 * The two resource reads take no querystring, so they are outside `format`.
 * Everything else served on an endpoint accepts the envelope — the aggregations
 * and the derived insight primitives alike (ADR 0051 §4).
 */
const FORMATTED_METRICS = allMetrics().filter(
  (metric) => metric.endpoint != null && isAggregateMetric(metric),
);

/** Every endpoint, including the two resource reads, for the `full` sweep. */
const METRICS_WITH_ENDPOINTS = allMetrics().filter((metric) => metric.endpoint != null);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("result format envelopes", () => {
  let app: FastifyInstance;
  const sink: { last: unknown } = { last: undefined };
  /** Filled as the sweep runs; printed under `RECORD_FULL_HASHES=1`. */
  const recordedHashes: Record<string, string> = {};

  beforeAll(async () => {
    const base = await createDuckdbStore(":memory:");
    await base.insertEvents(PARITY_EVENTS);
    await base.putSceneProxy(PARITY_PROJECT_ID, PROXY, "Main Lobby");
    // Record what each handler returned, so `full` can be compared against the
    // store's own output rather than only against itself.
    const recording = new Proxy(base, {
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
    const store: CollectorStore = {
      ...recording,
      resolveApiKey: async (key) =>
        key === API_KEY
          ? {
              projectId: PARITY_PROJECT_ID,
              keyId: "result-format-key-id",
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

  async function get(metric: MetricDefinition, extra: Record<string, string> = {}) {
    return app.inject({
      method: "GET",
      url: requestUrl(metric, extra),
      headers: { "x-api-key": API_KEY },
    });
  }

  it(`sweeps every registry endpoint (${FORMATTED_METRICS.length} formatted)`, () => {
    expect(FORMATTED_METRICS.length).toBeGreaterThan(60);
    expect(METRICS_WITH_ENDPOINTS.length - FORMATTED_METRICS.length).toBe(RESOURCE_METRICS.size);
  });

  // --- the negative promise: `full` is untouched ---------------------------

  describe.each(METRICS_WITH_ENDPOINTS.map((metric) => [metric.id, metric] as const))(
    "%s",
    (id, metric) => {
      it("returns exactly the store's rows, with and without format=full", async () => {
        sink.last = undefined;
        const implicit = await get(metric);
        const produced = JSON.parse(JSON.stringify(sink.last ?? null)) as unknown;
        if (implicit.statusCode === 404 && RESOURCE_METRICS.has(id)) return;
        expect(implicit.statusCode, `${id}: ${implicit.body.slice(0, 300)}`).toBe(200);

        // Every key the store produced is still on the wire with an equal value.
        // (The three spatial `stats` routes add the resolved `cellSize`, so the
        // response is a superset rather than an exact match.)
        //
        // A **derived** metric is exempt from *this* comparison only: its handler
        // reads a bucket series and computes its row in TypeScript, so the last
        // store result is not the row. The two assertions that actually carry the
        // negative promise — default equals `format=full`, and both still hash to
        // the recorded body — apply to it unchanged.
        const bodyValue: unknown = implicit.json();
        if (!isDerivedMetric(metric)) {
          const producedRows = Array.isArray(produced)
            ? produced
            : produced == null
              ? []
              : [produced];
          const bodyRows = Array.isArray(bodyValue) ? bodyValue : [bodyValue];
          expect(bodyRows.length, `${id}: row count changed`).toBe(producedRows.length);
          for (const [index, row] of producedRows.entries()) {
            expect(bodyRows[index], `${id}: row ${index} changed`).toMatchObject(
              row as Record<string, unknown>,
            );
          }
        }

        if (RESOURCE_METRICS.has(id)) return;
        const explicit = await get(metric, { format: "full" });
        expect(explicit.statusCode).toBe(200);
        expect(canonicalBody(explicit.json())).toBe(canonicalBody(bodyValue));

        recordedHashes[metric.endpoint!.path] = sha256(canonicalBody(bodyValue));
        const recorded = PRE_CHANGE_BODY_HASHES[metric.endpoint!.path];
        if (recorded != null) {
          expect(sha256(canonicalBody(bodyValue)), `${id}: default response changed`).toBe(
            recorded,
          );
        }
      });
    },
  );

  it("has a recorded pre-change hash for every formatted endpoint", () => {
    if (process.env.RECORD_FULL_HASHES === "1") {
      console.log(JSON.stringify(recordedHashes, null, 2));
      return;
    }
    const missing = FORMATTED_METRICS.map((metric) => metric.endpoint!.path).filter(
      (path) => PRE_CHANGE_BODY_HASHES[path] == null,
    );
    expect(missing, `no pre-change hash recorded for: ${missing.join(", ")}`).toEqual([]);
  });

  // --- the positive half: the two envelopes --------------------------------

  describe.each(FORMATTED_METRICS.map((metric) => [metric.id, metric] as const))(
    "%s",
    (id, metric) => {
      it("wraps the same rows in a meta envelope for format=table", async () => {
        const full = await get(metric, { format: "full" });
        const table = await get(metric, { format: "table" });
        expect(table.statusCode, `${id}: ${table.body.slice(0, 300)}`).toBe(200);

        const parsed = tableResultSchema(z.unknown()).safeParse(table.json());
        expect(parsed.success, `${id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);

        const body = table.json() as { meta: Record<string, unknown>; rows: unknown[] };
        expect(body.meta.metric).toBe(id);
        expect(body.meta.limits).toEqual(metric.limits);
        // The rows are the `full` payload, unchanged — wrapped, never rewritten.
        expect(canonicalBody(body.rows)).toBe(canonicalBody(full.json()));
        expect(body.meta.rows).toBe(body.rows.length);
      });

      it("returns a bounded, self-describing digest for format=summary", async () => {
        const response = await get(metric, { format: "summary" });
        expect(response.statusCode, `${id}: ${response.body.slice(0, 300)}`).toBe(200);

        const parsed = resultSummarySchema.safeParse(response.json());
        expect(parsed.success, `${id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
        if (!parsed.success) return;

        const summary = parsed.data;
        expect(summary.metric).toBe(id);
        expect(summary.reading).not.toMatch(/undefined|NaN/);
        expect(summary.caveats.length).toBeGreaterThan(0);
        if (summary.kind === "ranked") {
          expect(summary.top.length).toBeLessThanOrEqual(metric.limits.maxSummaryRows);
        }
        if (summary.kind === "clusters") {
          expect(summary.clusters.length).toBeLessThanOrEqual(metric.limits.maxSummaryRows);
        }
      });
    },
  );

  it("echoes the applied filters, never `format` itself", async () => {
    const metric = allMetrics().find((candidate) => candidate.id === "top_meshes")!;
    const response = await get(metric, { format: "table", limit: "5" });
    const body = response.json() as { meta: { filters: Record<string, unknown> } };
    expect(body.meta.filters.limit).toBe(5);
    expect(body.meta.filters).not.toHaveProperty("format");
  });

  it("names the path parameter by its registry filter id", async () => {
    const metric = allMetrics().find((candidate) => candidate.id === "session_trajectory")!;
    const response = await get(metric, { format: "table" });
    const body = response.json() as { meta: { filters: Record<string, unknown> } };
    expect(body.meta.filters.session).toBe("s1");
  });

  it("summarises a voxel heatmap as clusters with a world-space drill hint", async () => {
    const metric = allMetrics().find((candidate) => candidate.id === "world_heatmap")!;
    const response = await get(metric, { format: "summary", scene: "lobby" });
    const body = response.json() as {
      kind: string;
      axes: string[];
      clusters: { drill?: Record<string, string> }[];
    };
    expect(body.kind).toBe("clusters");
    expect(body.axes).toEqual(["vx", "vy", "vz"]);
    for (const cluster of body.clusters) {
      // The scene has registered bounds, so the collector resolved a cell size
      // and every cluster can be re-queried as a `region` box.
      expect(cluster.drill?.region).toMatch(/^-?[\d.]+(,-?[\d.]+){5}$/);
    }
  });

  it("ignores a stray format on the two resource reads", async () => {
    // A resource declares no querystring schema, so `?format=` reaches the route
    // unvalidated. It is a stored record, not an aggregation — there is nothing
    // to summarise, and wrapping it would break its response schema.
    for (const url of [
      "/api/v1/sessions/s1/meta?format=summary",
      "/api/v1/scenes/lobby/representation?format=table",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-api-key": API_KEY } });
      expect([200, 404], `${url} → ${response.statusCode}`).toContain(response.statusCode);
      if (response.statusCode !== 200) continue;
      const body = response.json() as Record<string, unknown>;
      // (`scene_representation` legitimately has its own `kind` column, so the
      // envelope is identified by `reading`/`rows` instead.)
      expect(body).not.toHaveProperty("meta");
      expect(body).not.toHaveProperty("rows");
      expect(body).not.toHaveProperty("reading");
    }
  });

  it("rejects an unknown format with a 400", async () => {
    const metric = allMetrics().find((candidate) => candidate.id === "top_meshes")!;
    const response = await get(metric, { format: "csv" });
    expect(response.statusCode).toBe(400);
  });

  it("leaves the raw session-event stream's own `format` alone", async () => {
    // `/sessions/:id/events` has carried a `format=json|ndjson` since long before
    // the envelope; it is not a registry metric and must not be swept up.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/s1/events?format=ndjson",
      headers: { "x-api-key": API_KEY },
    });
    // Raw retention is off in the test config, so this is a 403 — the point is
    // that the parameter was accepted rather than rejected as an envelope name.
    expect(response.statusCode).toBe(403);
  });

  it("leaves the key-identity routes untouched by the envelope hook", async () => {
    // `/whoami` and `/audit` describe the **calling key** and its activity, not
    // the project's telemetry (#309, ADR 0051 §5/§7). They are in the collector's
    // `ROUTES_WITHOUT_METRICS` list, so `METRIC_BY_PATH` misses them and the
    // `preSerialization` hook must hand their payloads back unchanged — even when
    // a caller sends `format=` at them.
    const whoami = await app.inject({
      method: "GET",
      url: "/api/v1/whoami?format=summary",
      headers: { "x-api-key": API_KEY },
    });
    expect(whoami.statusCode, whoami.body.slice(0, 200)).toBe(200);
    const identity = whoami.json() as Record<string, unknown>;
    expect(identity).toMatchObject({
      projectId: PARITY_PROJECT_ID,
      keyId: "result-format-key-id",
      capabilities: ["query"],
    });
    for (const envelopeKey of ["meta", "rows", "reading", "kind", "top", "clusters"]) {
      expect(identity, `whoami carries an envelope key: ${envelopeKey}`).not.toHaveProperty(
        envelopeKey,
      );
    }

    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/audit?format=table",
      headers: { "x-api-key": API_KEY },
    });
    expect(audit.statusCode, audit.body.slice(0, 200)).toBe(200);
    // A bare array, never a `{ meta, rows }` envelope.
    expect(Array.isArray(audit.json())).toBe(true);
  });
});
