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
