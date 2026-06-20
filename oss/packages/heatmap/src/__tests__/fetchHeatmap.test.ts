import { describe, expect, it, vi } from "vitest";
import { fetchGazeHeatmap, fetchWorldHeatmap } from "../fetchHeatmap.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("fetchWorldHeatmap", () => {
  it("builds the query string and returns the requested cellSize", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ vx: 0, vy: 1, vz: 2, count: 3 }]));
    const result = await fetchWorldHeatmap({
      endpoint: "https://collect.example.com",
      apiKey: "k",
      sceneId: "lobby",
      source: "mouse",
      cellSize: 0.25,
      since: 100,
      until: 200,
      limit: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/api/v1/heatmaps/world?");
    expect(url).toContain("scene=lobby");
    expect(url).toContain("source=mouse");
    expect(url).toContain("cellSize=0.25");
    expect(url).toContain("since=100");
    expect(url).toContain("until=200");
    expect(url).toContain("limit=500");
    expect(fetchImpl.mock.calls[0]![1]).toEqual({ headers: { "x-api-key": "k" } });
    expect(result.cellSize).toBe(0.25);
    expect(result.voxels).toEqual([{ vx: 0, vy: 1, vz: 2, count: 3 }]);
  });

  it("defaults cellSize to 0.5 and coerces string counts", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ vx: "1", vy: "2", vz: "3", count: "42" }]));
    const result = await fetchWorldHeatmap({
      endpoint: "https://c",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.cellSize).toBe(0.5);
    expect(result.voxels).toEqual([{ vx: 1, vy: 2, vz: 3, count: 42 }]);
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("cellSize=0.5");
    expect(url).not.toContain("scene=");
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, false, 401));
    await expect(
      fetchWorldHeatmap({
        endpoint: "https://c",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/401/);
  });

  it("returns an empty voxel list for a non-array body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));
    const result = await fetchWorldHeatmap({
      endpoint: "https://c",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.voxels).toEqual([]);
  });
});

describe("fetchGazeHeatmap", () => {
  it("builds the camera query string and echoes the requested bins as gridSize", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ azimuth_bin: 3, elevation_bin: 7, count: 12 }]),
    );
    const result = await fetchGazeHeatmap({
      endpoint: "https://collect.example.com",
      apiKey: "k",
      sceneId: "lobby",
      sessionId: "sess-1",
      bins: 24,
      since: 100,
      until: 200,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/api/v1/heatmaps/camera?");
    expect(url).toContain("scene=lobby");
    expect(url).toContain("session=sess-1");
    expect(url).toContain("bins=24");
    expect(url).toContain("since=100");
    expect(url).toContain("until=200");
    expect(fetchImpl.mock.calls[0]![1]).toEqual({ headers: { "x-api-key": "k" } });
    expect(result.gridSize).toBe(24);
    expect(result.bins).toEqual([{ azimuthBin: 3, elevationBin: 7, count: 12 }]);
  });

  it("defaults bins to 36 and coerces string counts", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ azimuth_bin: "1", elevation_bin: "2", count: "9" }]),
    );
    const result = await fetchGazeHeatmap({
      endpoint: "https://c",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.gridSize).toBe(36);
    expect(result.bins).toEqual([{ azimuthBin: 1, elevationBin: 2, count: 9 }]);
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("bins=36");
    expect(url).not.toContain("scene=");
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, false, 403));
    await expect(
      fetchGazeHeatmap({
        endpoint: "https://c",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/403/);
  });

  it("returns an empty bin list for a non-array body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));
    const result = await fetchGazeHeatmap({
      endpoint: "https://c",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.bins).toEqual([]);
  });
});
