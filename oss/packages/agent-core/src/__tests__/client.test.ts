import { describe, expect, it, vi } from "vitest";
import { createCollectorClient, CollectorError } from "../client.js";

const config = { collectorUrl: "https://collect.example.com", apiKey: "utk_test" };

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createCollectorClient", () => {
  it("issues a GET with the api key header and omits undefined params", async () => {
    const fetchImpl = vi.fn(async () => okResponse([{ ok: true }]));
    const client = createCollectorClient(config, fetchImpl as unknown as typeof fetch);

    const result = await client.get("api/v1/sessions", { limit: 10, since: undefined });

    expect(result).toEqual([{ ok: true }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    const requested = new URL((url as URL).toString());
    expect(requested.pathname).toBe("/api/v1/sessions");
    expect(requested.searchParams.get("limit")).toBe("10");
    expect(requested.searchParams.has("since")).toBe(false);
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "utk_test" });
  });

  it("resolves the path against a base url without a trailing slash", async () => {
    const fetchImpl = vi.fn(async () => okResponse({}));
    const client = createCollectorClient(
      { collectorUrl: "https://collect.example.com", apiKey: "k" },
      fetchImpl as unknown as typeof fetch,
    );
    await client.get("api/v1/perf");
    const [url] = fetchImpl.mock.calls[0]!;
    expect((url as URL).toString()).toBe("https://collect.example.com/api/v1/perf");
  });

  it("throws CollectorError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = createCollectorClient(config, fetchImpl as unknown as typeof fetch);
    await expect(client.get("api/v1/sessions")).rejects.toBeInstanceOf(CollectorError);
    await expect(client.get("api/v1/sessions")).rejects.toMatchObject({ status: 401 });
  });
});
