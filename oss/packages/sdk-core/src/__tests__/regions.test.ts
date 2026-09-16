import { describe, expect, it, vi } from "vitest";
import type { SceneRegion } from "@uptimizr/schema";
import { registerRegions } from "../regions.js";

const REGIONS: SceneRegion[] = [
  { id: "entrance", label: "Entrance", bounds: [-5, 0, -5, 5, 3, 0] },
  { id: "counter", label: "Checkout counter", bounds: [-1, 0, 1, 1, 2, 3] },
];

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
}

describe("registerRegions", () => {
  it("PUTs the scene's region set with the project API key", async () => {
    const fetchImpl = okFetch();
    await registerRegions("lobby", REGIONS, {
      endpoint: "http://collector.test",
      apiKey: "utk_secret",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("http://collector.test/api/v1/scenes/lobby/regions");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-api-key": "utk_secret",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ regions: REGIONS });
  });

  it("normalizes a trailing slash on the endpoint and encodes the scene id", async () => {
    const fetchImpl = okFetch();
    await registerRegions("lobby/east", REGIONS, {
      endpoint: "http://collector.test/",
      apiKey: "k",
      fetchImpl,
    });
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe(
      "http://collector.test/api/v1/scenes/lobby%2Feast/regions",
    );
  });

  it("sends an empty set, which clears the scene's regions", async () => {
    const fetchImpl = okFetch();
    await registerRegions("lobby", [], {
      endpoint: "http://collector.test",
      apiKey: "k",
      fetchImpl,
    });
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]?.body))).toEqual({
      regions: [],
    });
  });

  it("validates locally before sending — an inverted box never leaves the browser", async () => {
    const fetchImpl = okFetch();
    await expect(
      registerRegions("lobby", [{ id: "bad", label: "Bad", bounds: [0, 0, 0, -1, 1, 1] }], {
        endpoint: "http://collector.test",
        apiKey: "k",
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects duplicate region ids locally", async () => {
    const fetchImpl = okFetch();
    await expect(
      registerRegions("lobby", [REGIONS[0]!, REGIONS[0]!], {
        endpoint: "http://collector.test",
        apiKey: "k",
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws with the status and the collector's message when the write is refused", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("invalid api key", { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      registerRegions("lobby", REGIONS, {
        endpoint: "http://collector.test",
        apiKey: "nope",
        fetchImpl,
      }),
    ).rejects.toThrow(/401.*invalid api key/);
  });
});
