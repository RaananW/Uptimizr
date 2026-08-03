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

  it("maps reachability bins and forwards the bucket size (#151)", async () => {
    const fetchMock = mockFetch([
      { mesh: "far-panel", bucket: "4", count: "7", avg_distance: "4.6" },
      { mesh: "near-panel", bucket: "0", count: "12", avg_distance: "0.3" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.reachability({ bucketSize: 1, scene: "lobby" });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      "http://localhost:4318/api/v1/meshes/reachability",
    );
    expect(parsed.searchParams.get("bucketSize")).toBe("1");
    expect(parsed.searchParams.get("scene")).toBe("lobby");
    expect(rows).toEqual([
      { mesh: "far-panel", bucket: 4, count: 7, avg_distance: 4.6 },
      { mesh: "near-panel", bucket: 0, count: 12, avg_distance: 0.3 },
    ]);
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

  it("coerces blind-spot rows and hits the blind-spots endpoint (#143)", async () => {
    const fetchMock = mockFetch([
      {
        mesh: "engraving",
        visible_ms: "12000",
        vis_samples: "3",
        interactions: "0",
        hover_ms: "0",
        hover_episodes: "0",
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.meshBlindSpots({ scene: "lobby", limit: 10 });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/meshes/blind-spots");
    expect(rows[0]).toEqual({
      mesh: "engraving",
      visible_ms: 12000,
      vis_samples: 3,
      interactions: 0,
      hover_ms: 0,
      hover_episodes: 0,
    });
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

  it("encodes load-bounce bands into the query and coerces the result (#152)", async () => {
    const fetchMock = mockFetch([
      { band: "0", sessions: "20", bounced: "3" },
      { band: "3", sessions: "8", bounced: "6" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.loadBounce({ scene: "lobby", bands: [1000, 3000, 5000] });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/load-bounce");
    expect(parsed.searchParams.get("scene")).toBe("lobby");
    expect(parsed.searchParams.get("bands")).toBe("1000,3000,5000");
    expect(rows).toEqual([
      { band: 0, sessions: 20, bounced: 3 },
      { band: 3, sessions: 8, bounced: 6 },
    ]);
  });

  it("omits the bands param when no bands are supplied (#152)", async () => {
    const fetchMock = mockFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    await api.loadBounce({ scene: "lobby" });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.searchParams.has("bands")).toBe(false);
  });

  it("encodes variant/conversion predicates and derives the conversion rate (#150)", async () => {
    const fetchMock = mockFetch([
      { variant: "red", views: "6", sessions: "4", conversions: "3", avg_dwell_ms: "1500" },
      { variant: "blue", views: "2", sessions: "2", conversions: "0", avg_dwell_ms: "0" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.variantLeaderboard(
      { conversion: { type: "custom", name: "add_to_cart" } },
      { scene: "shop", limit: 10 },
    );

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      "http://localhost:4318/api/v1/variant-leaderboard",
    );
    expect(parsed.searchParams.get("scene")).toBe("shop");
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect(JSON.parse(parsed.searchParams.get("conversion") ?? "{}")).toEqual({
      type: "custom",
      name: "add_to_cart",
    });
    expect(parsed.searchParams.get("variant")).toBeNull();
    expect(rows[0]).toEqual({
      variant: "red",
      views: 6,
      sessions: 4,
      conversions: 3,
      avgDwellMs: 1500,
      conversionRate: 0.75,
    });
    expect(rows[1].conversionRate).toBe(0);
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

  it("coerces XR locomotion rows and hits the xr/locomotion endpoint (#148)", async () => {
    const fetchMock = mockFetch([
      {
        session_id: "xr1",
        fly_gestures: "12",
        navigate_gestures: "2",
        teleports: "3",
        locomotion_ms: "4200",
        started_at: "2024-06-16 10:00:00.000",
        ended_at: "2024-06-16 10:00:25.000",
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.xrLocomotion({ scene: "arena", session: "xr1" });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/xr/locomotion");
    expect(parsed.searchParams.get("scene")).toBe("arena");
    expect(rows[0]).toEqual({
      session_id: "xr1",
      fly_gestures: 12,
      navigate_gestures: 2,
      teleports: 3,
      locomotion_ms: 4200,
      started_at: "2024-06-16 10:00:00.000",
      ended_at: "2024-06-16 10:00:25.000",
    });
  });

  it("coerces graphics-diagnostic counts and hits the graphics-diagnostics endpoint (#16)", async () => {
    const fetchMock = mockFetch([
      { severity: "fatal", category: "device-lost", backend: "webgpu", incidents: "2" },
      { severity: "error", category: "shader-compile", backend: null, incidents: "1" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.graphicsDiagnosticCounts({ scene: "s", session: "s1" });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      "http://localhost:4318/api/v1/graphics-diagnostics",
    );
    expect(parsed.searchParams.get("scene")).toBe("s");
    expect(parsed.searchParams.get("session")).toBe("s1");
    expect(rows).toEqual([
      { severity: "fatal", category: "device-lost", backend: "webgpu", incidents: 2 },
      // A null backend coerces to "" (unknown).
      { severity: "error", category: "shader-compile", backend: "", incidents: 1 },
    ]);
  });

  it("coerces AR placement time-to-place bins and forwards the ms bucket (#156)", async () => {
    const fetchMock = mockFetch([{ bucket: "0", placements: "3" }]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.arPlacementTimeToPlace({ scene: "room", bucketMs: 1000 });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      "http://localhost:4318/api/v1/ar/placement/time-to-place",
    );
    expect(parsed.searchParams.get("scene")).toBe("room");
    expect(parsed.searchParams.get("bucketMs")).toBe("1000");
    expect(rows).toEqual([{ bucket: 0, placements: 3 }]);
  });

  it("coerces AR re-placement attempt rows and hits the attempts endpoint (#156)", async () => {
    const fetchMock = mockFetch([{ attempts: "1", placements: "5" }]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.arPlacementAttempts({ session: "s1" });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      "http://localhost:4318/api/v1/ar/placement/attempts",
    );
    expect(parsed.searchParams.get("session")).toBe("s1");
    expect(rows).toEqual([{ attempts: 1, placements: 5 }]);
  });

  it("coerces AR surface-breakdown rows and hits the surfaces endpoint (#156)", async () => {
    const fetchMock = mockFetch([{ surface: "floor", placements: "4", avg_scale: "1.25" }]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.arPlacementSurfaces({ scene: "room" });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      "http://localhost:4318/api/v1/ar/placement/surfaces",
    );
    expect(rows).toEqual([{ surface: "floor", placements: 4, avg_scale: 1.25 }]);
  });

  it("coerces rendering-technology counts and hits the rendering-technology endpoint (#120)", async () => {
    const fetchMock = mockFetch([
      {
        api: "webgpu",
        backend: "metal",
        api_version: "1.0",
        shading_language: "wgsl",
        sessions: "7",
      },
      { api: null, backend: null, api_version: null, shading_language: null, sessions: "3" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const api = new CollectorApi("http://localhost:4318", "k");
    const rows = await api.renderingTechnology({ scene: "s", session: "s1" });

    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      "http://localhost:4318/api/v1/rendering-technology",
    );
    expect(parsed.searchParams.get("scene")).toBe("s");
    expect(rows).toEqual([
      { api: "webgpu", backend: "metal", apiVersion: "1.0", shadingLanguage: "wgsl", sessions: 7 },
      // Missing fields coerce to "" (unknown).
      { api: "", backend: "", apiVersion: "", shadingLanguage: "", sessions: 3 },
    ]);
  });

  it("read() issues a plain GET passthrough — never a mutation (#192)", async () => {
    const fetchMock = mockFetch([{ ok: true }]);
    vi.stubGlobal("fetch", fetchMock);

    const api = new CollectorApi("http://localhost:4318", "secret-key");
    await api.read("api/v1/top-meshes", { scene: "lobby", limit: 5 });

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("http://localhost:4318/api/v1/top-meshes");
    expect(parsed.searchParams.get("scene")).toBe("lobby");
    expect(parsed.searchParams.get("limit")).toBe("5");
    // The assistant transport must be read-only: the underlying fetch carries no
    // HTTP method override (defaults to GET) and no request body — it cannot POST,
    // PUT, PATCH, or DELETE, so it can never mutate collector state (ADR 0050).
    const requestInit = (init ?? {}) as RequestInit;
    expect(requestInit.method ?? "GET").toBe("GET");
    expect(requestInit.body).toBeUndefined();
    expect(requestInit.headers).toMatchObject({ "x-api-key": "secret-key" });
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
