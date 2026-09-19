/**
 * Spatial labelling on `format=summary` (ADR 0051 §2, design sketch §B.2) —
 * end to end through the collector.
 *
 * `@uptimizr/db`'s `spatialLabels` suite proves the geometry; this one proves the
 * wiring: that the `preSerialization` hook loads the selected scene's regions and
 * proxy exactly once, hands them to the summariser, and that what comes back over
 * HTTP names the place — with the region id as the `drill.region` hint an agent
 * can send straight back as `?region=`.
 *
 * It also pins the two negatives that matter:
 *
 * - `full` and `table` are **untouched**. Labelling is a `summary` enrichment, so
 *   a default request must not pay for it or see it.
 * - a scene with no proxy (or no regions) gets `null` labels plus a caveat that
 *   names what is missing — never a confident guess.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnyEvent, SceneProxy, SceneRegion } from "@uptimizr/schema";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { createDuckdbStore } from "../duckdbStore.js";
import type { CollectorStore } from "../store.js";
import { TEST_CONFIG as config } from "./support/registryRequests.js";

const API_KEY = "spatial-label-key";
const PROJECT_ID = "labelling-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 60_000 };

/**
 * A shop-floor fixture at `cellSize` 0.5: a dense knot of clicks on the checkout
 * button (world ≈ 2, 1, 2) and a sparser one out by the shelf (world ≈ 8, 1, 8).
 */
function clicks(): AnyEvent[] {
  const events: AnyEvent[] = [];
  const at = (n: number, point: [number, number, number]) => {
    for (let i = 0; i < n; i++) {
      events.push({
        type: "pointer_click",
        projectId: PROJECT_ID,
        sessionId: "s1",
        ts: T0 + events.length * 10,
        sdkVersion: "0.1.0",
        sceneId: "lobby",
        pointer: [0.5, 0.5],
        hitPoint: point,
      } as unknown as AnyEvent);
    }
  };
  at(8, [2.05, 1.05, 2.05]);
  at(2, [8.2, 1.1, 8.2]);
  return events;
}

const PROXY: SceneProxy = {
  version: 1,
  sceneId: "lobby",
  kind: "aabb",
  bounds: [0, 0, 0, 10, 10, 10],
  upAxis: "y",
  unitScale: 1,
  meshes: [
    { name: "floor", aabb: [0, -0.1, 0, 10, 0, 10] },
    // Sized so the voxel centre of the dense knot (world 2.25, 1.25, 2.25 at
    // `cellSize` 0.5) falls inside the box — the containment case, distance 0.
    { name: "checkout_button", aabb: [1.9, 1, 1.9, 2.4, 1.4, 2.4] },
    { name: "shelf", aabb: [8, 0, 8, 9, 2, 9] },
  ],
  meshCount: 3,
  contentHash: "labelling-fixture",
  capturedAt: T0,
  sdkVersion: "0.1.0",
};

const REGIONS: readonly SceneRegion[] = [
  { id: "shop-floor", label: "Shop floor", bounds: [0, 0, 0, 10, 10, 10] },
  { id: "counter", label: "Checkout counter", bounds: [1, 0, 1, 3, 2, 3] },
];

/** One collector over a fresh in-memory store, with the given scene metadata. */
async function buildCollector(opts: {
  proxy?: SceneProxy;
  regions?: readonly SceneRegion[];
}): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const base = await createDuckdbStore(":memory:");
  await base.insertEvents(clicks());
  if (opts.proxy) await base.putSceneProxy(PROJECT_ID, opts.proxy, "Main Lobby");
  if (opts.regions) await base.putSceneRegions(PROJECT_ID, "lobby", opts.regions);
  const store: CollectorStore = {
    ...base,
    resolveApiKey: async (key) =>
      key === API_KEY
        ? {
            projectId: PROJECT_ID,
            keyId: "spatial-label-key-id",
            capabilities: ["query"],
            label: null,
            rateLimit: null,
          }
        : null,
  };
  const app = await buildApp({ store, config });
  return {
    app,
    close: async () => {
      await app.close();
      await base.close();
    },
  };
}

/** `GET /heatmaps/world` with the fixture range and an explicit cell size. */
function worldUrl(extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    since: String(RANGE.since),
    until: String(RANGE.until),
    cellSize: "0.5",
    ...extra,
  });
  return `/api/v1/heatmaps/world?${params.toString()}`;
}

interface LabelledCluster {
  centroid: number[];
  weight: number;
  region?: string | null;
  regions?: string[];
  nearestMesh?: string | null;
  distance?: number | null;
  drill?: Record<string, string>;
}

interface ClusterBody {
  kind: string;
  clusters: LabelledCluster[];
  reading: string;
  caveats: string[];
}

describe("spatial labelling — scene with a proxy and regions", () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ app, close } = await buildCollector({ proxy: PROXY, regions: REGIONS }));
  });
  afterAll(async () => close?.());

  const get = (url: string) =>
    app.inject({ method: "GET", url, headers: { "x-api-key": API_KEY } });

  it("labels each hotspot with its region and nearest mesh", async () => {
    const response = await get(worldUrl({ format: "summary", scene: "lobby" }));
    expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
    const body = response.json() as ClusterBody;
    expect(body.kind).toBe("clusters");

    const densest = body.clusters[0];
    expect(densest?.nearestMesh).toBe("checkout_button");
    expect(densest?.distance).toBe(0);
    // Regions overlap; the smallest containing one is the reported `region`,
    // and every containing id is listed.
    expect(densest?.region).toBe("counter");
    expect(densest?.regions).toEqual(["counter", "shop-floor"]);
  });

  it("hands back the region id as the drill hint", async () => {
    const body = (await get(worldUrl({ format: "summary", scene: "lobby" }))).json() as ClusterBody;
    // `?region=counter` is resolved server-side to the stored bounds, so the id
    // is a strictly better hint than the ad-hoc box it replaces.
    expect(body.clusters[0]?.drill?.region).toBe("counter");
  });

  it("names the place in the reading sentence", async () => {
    const body = (await get(worldUrl({ format: "summary", scene: "lobby" }))).json() as ClusterBody;
    expect(body.reading).toContain("`checkout_button`");
    expect(body.reading).toContain("in region `counter`");
    expect(body.reading).not.toMatch(/undefined|NaN/);
  });

  it("labels the implied scene when the project has exactly one", async () => {
    const body = (await get(worldUrl({ format: "summary" }))).json() as ClusterBody;
    expect(body.clusters[0]?.nearestMesh).toBe("checkout_button");
  });

  it("leaves `full` and `table` untouched", async () => {
    const full = await get(worldUrl({ scene: "lobby" }));
    expect(full.statusCode).toBe(200);
    const rows = full.json() as Record<string, unknown>[];
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["count", "vx", "vy", "vz"]);
    }

    const table = await get(worldUrl({ format: "table", scene: "lobby" }));
    const body = table.json() as { rows: Record<string, unknown>[] };
    expect(body.rows).toEqual(rows);
  });
});

describe("spatial labelling — what the scene has not registered", () => {
  it("caveats a missing proxy and reports nearestMesh as null", async () => {
    const { app, close } = await buildCollector({ regions: REGIONS });
    try {
      const response = await app.inject({
        method: "GET",
        url: worldUrl({ format: "summary", scene: "lobby" }),
        headers: { "x-api-key": API_KEY },
      });
      const body = response.json() as ClusterBody;
      expect(body.clusters[0]?.nearestMesh).toBeNull();
      expect(body.clusters[0]?.distance).toBeNull();
      expect(body.clusters[0]?.region).toBe("counter");
      expect(body.caveats.join(" ")).toContain("No proxy registered for scene `lobby`");
    } finally {
      await close();
    }
  });

  it("caveats missing regions and keeps the world-box drill hint", async () => {
    const { app, close } = await buildCollector({ proxy: PROXY });
    try {
      const response = await app.inject({
        method: "GET",
        url: worldUrl({ format: "summary", scene: "lobby" }),
        headers: { "x-api-key": API_KEY },
      });
      const body = response.json() as ClusterBody;
      expect(body.clusters[0]?.region).toBeNull();
      expect(body.clusters[0]?.regions).toEqual([]);
      expect(body.clusters[0]?.nearestMesh).toBe("checkout_button");
      expect(body.caveats.join(" ")).toContain("No regions defined for scene `lobby`");
      // Without a named region the hint stays the ad-hoc world box (ADR 0040 §4).
      expect(body.clusters[0]?.drill?.region).toMatch(/^-?[\d.]+(,-?[\d.]+){5}$/);
    } finally {
      await close();
    }
  });

  it("does not label a viewport-binned heatmap", async () => {
    // `pointer_heatmap`'s `gx`/`gy` are normalised viewport cells, not world
    // coordinates — a world box there would be a category error, so the envelope
    // carries no label fields at all.
    const { app, close } = await buildCollector({ proxy: PROXY, regions: REGIONS });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/heatmaps/pointer?since=${RANGE.since}&until=${RANGE.until}&format=summary&scene=lobby`,
        headers: { "x-api-key": API_KEY },
      });
      expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
      const body = response.json() as ClusterBody;
      for (const cluster of body.clusters) {
        expect(cluster).not.toHaveProperty("region");
        expect(cluster).not.toHaveProperty("nearestMesh");
      }
    } finally {
      await close();
    }
  });
});
