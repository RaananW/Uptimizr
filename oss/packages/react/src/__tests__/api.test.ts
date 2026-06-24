import { describe, expect, it, vi, afterEach } from "vitest";
import { ApiError, CollectorApi } from "../api";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("CollectorApi", () => {
  it("sends the API key and builds query params against the base URL", async () => {
    const fetchMock = mockFetch([]);
    vi.stubGlobal("fetch", fetchMock);

    const api = new CollectorApi("http://localhost:4318", "secret-key");
    await api.sessions({ since: 1000, limit: 5 });

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/sessions");
    expect(parsed.searchParams.get("since")).toBe("1000");
    expect(parsed.searchParams.get("limit")).toBe("5");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "secret-key" });
  });

  it("coerces string aggregate columns to numbers (sessions.events)", async () => {
    vi.stubGlobal("fetch", mockFetch([{ session_id: "s1", visitor_id: "v1", events: "42" }]));
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.sessions();
    expect(rows[0]?.events).toBe(42);
  });

  it("throws an ApiError carrying the HTTP status on failure", async () => {
    vi.stubGlobal("fetch", mockFetch({ error: "nope" }, false, 401));
    const api = new CollectorApi("http://localhost:4318", "bad");
    await expect(api.sessions()).rejects.toBeInstanceOf(ApiError);
    await expect(api.sessions()).rejects.toMatchObject({ status: 401 });
  });

  it("returns null from sceneRepresentation on a 404", async () => {
    vi.stubGlobal("fetch", mockFetch({}, false, 404));
    const api = new CollectorApi("http://localhost:4318", "k");
    await expect(api.sceneRepresentation("scene-1")).resolves.toBeNull();
  });

  it("derives the downscaled share from render-scale counts (#71)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          samples: "3",
          avg_fps: "45",
          p50_fps: "45",
          avg_render_scale: "0.9333333333333333",
          p50_render_scale: "1",
          downscaled_samples: "1",
          scale_samples: "4",
        },
      ]),
    );
    const api = new CollectorApi("http://localhost:4318", "k");
    const data = await api.renderScale();
    expect(data.samples).toBe(3);
    expect(data.p50_render_scale).toBe(1);
    expect(data.downscaled_share).toBeCloseTo(0.25, 5);
  });

  it("returns a zero downscaled share when nothing reported a render scale", async () => {
    vi.stubGlobal("fetch", mockFetch([{ samples: "0", scale_samples: "0" }]));
    const api = new CollectorApi("http://localhost:4318", "k");
    const data = await api.renderScale();
    expect(data.downscaled_share).toBe(0);
  });

  it("coerces the mesh interaction-kind breakdown to numbers (#72)", async () => {
    vi.stubGlobal("fetch", mockFetch([{ mesh: "door", kind: "hover", count: "2" }]));
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.meshKinds();
    expect(rows[0]).toEqual({ mesh: "door", kind: "hover", count: 2 });
  });

  it("coerces aggregate desire-line points to numbers (#73)", async () => {
    vi.stubGlobal("fetch", mockFetch([{ session_id: "s1", ts: "1000", gx: "0", gz: "10" }]));
    const api = new CollectorApi("http://localhost:4318", "k");
    const points = await api.aggregatePaths();
    expect(points[0]).toEqual({ session_id: "s1", ts: 1000, gx: 0, gz: 10 });
  });

  it("coerces the per-mesh source split and hits the sources endpoint (#74)", async () => {
    const fetchMock = mockFetch([{ mesh: "door", source: "touch", count: "5" }]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.topMeshesBySource({ scene: "lobby" });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/meshes/sources");
    expect(rows[0]).toEqual({ mesh: "door", source: "touch", count: 5 });
  });

  it("coerces the per-mesh trend points and hits the trend endpoint (#74)", async () => {
    const fetchMock = mockFetch([{ mesh: "door", bucket: "1718532000000", count: "3" }]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.topMeshesTrend({ interval: 3600 });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/meshes/trend");
    expect(rows[0]).toEqual({ mesh: "door", bucket: 1718532000000, count: 3 });
  });

  it("coerces the most-used input actions and hits the input-actions endpoint (#75)", async () => {
    const fetchMock = mockFetch([{ action: "rotate-left", source: "keyboard", count: "12" }]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.topInputActions();

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/input-actions/top");
    expect(rows[0]).toEqual({ action: "rotate-left", source: "keyboard", count: 12 });
  });

  it("encodes funnel steps into the query and coerces the result (#78)", async () => {
    const fetchMock = mockFetch([
      { step: "0", sessions: "10" },
      { step: "1", sessions: "4" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const steps = [
      { type: "camera_gesture", name: "orbit" },
      { type: "mesh_interaction", name: "pick", mesh: "box" },
    ];
    const rows = await api.funnel(steps, { scene: "lobby" });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/funnel");
    expect(parsed.searchParams.get("scene")).toBe("lobby");
    expect(JSON.parse(parsed.searchParams.get("steps") ?? "[]")).toEqual(steps);
    expect(rows).toEqual([
      { step: 0, sessions: 10 },
      { step: 1, sessions: 4 },
    ]);
  });

  it("coerces camera-gesture rows and hits the camera-gestures endpoint", async () => {
    const fetchMock = mockFetch([
      { kind: "orbit", gestures: "9", total_ms: "4500", avg_ms: "500", max_ms: "1200" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.cameraGestures({ scene: "s" });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/camera-gestures");
    expect(rows[0]).toEqual({
      kind: "orbit",
      gestures: 9,
      total_ms: 4500,
      avg_ms: 500,
      max_ms: 1200,
    });
  });
});

describe("CollectorApi live (ADR 0032)", () => {
  it("POSTs the API key to mint a short-lived live token", async () => {
    const fetchMock = mockFetch({ token: "tok123", expiresAt: 9999 });
    vi.stubGlobal("fetch", fetchMock);

    const api = new CollectorApi("http://localhost:4318", "secret-key");
    const result = await api.liveToken();

    expect(result).toEqual({ token: "tok123", expiresAt: 9999 });
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/live/token");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "secret-key" });
  });

  it("throws an ApiError when token minting is rejected", async () => {
    vi.stubGlobal("fetch", mockFetch({ error: "nope" }, false, 401));
    const api = new CollectorApi("http://localhost:4318", "bad");
    await expect(api.liveToken()).rejects.toMatchObject({ status: 401 });
  });

  it("builds presence/stream/session SSE URLs with the token as a query param", () => {
    const api = new CollectorApi("http://localhost:4318", "k");

    const presence = new URL(api.livePresenceUrl("tok"));
    expect(presence.pathname).toBe("/api/v1/live/presence");
    expect(presence.searchParams.get("token")).toBe("tok");

    const stream = new URL(api.liveStreamUrl("tok", ["pointer_click", "custom"]));
    expect(stream.pathname).toBe("/api/v1/live/stream");
    expect(stream.searchParams.get("token")).toBe("tok");
    expect(stream.searchParams.get("types")).toBe("pointer_click,custom");

    const noTypes = new URL(api.liveStreamUrl("tok"));
    expect(noTypes.searchParams.has("types")).toBe(false);

    const session = new URL(api.liveSessionUrl("tok", "sess/1"));
    expect(session.pathname).toBe("/api/v1/live/sessions/sess%2F1");
    expect(session.searchParams.get("token")).toBe("tok");
  });
});
