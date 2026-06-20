import { describe, expect, it, vi } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { fetchSessionEvents, fetchSessionEventsStream } from "../fetchSession.js";

function camera(ts: number): AnyEvent {
  return {
    type: "camera_sample",
    projectId: "p",
    sessionId: "s",
    ts,
    sdkVersion: "0.1.0",
    position: [0, 0, 0],
    direction: [0, 0, 1],
  } as AnyEvent;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function ndjsonResponse(lines: string[], ok = true, status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return {
    ok,
    status,
    headers: new Headers({ "content-type": "application/x-ndjson; charset=utf-8" }),
    body,
  } as unknown as Response;
}

function arrayResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

async function collect(iter: AsyncIterable<AnyEvent>): Promise<AnyEvent[]> {
  const out: AnyEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe("fetchSessionEvents", () => {
  it("requests the replay endpoint with the api key and returns sorted events", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([camera(200), camera(100)]));
    const events = await fetchSessionEvents({
      endpoint: "https://collect.example.com",
      apiKey: "k",
      sessionId: "abc/def",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://collect.example.com/api/v1/sessions/abc%2Fdef/events",
      { headers: { "x-api-key": "k" } },
    );
    expect(events.map((e) => e.ts)).toEqual([100, 200]);
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, false, 403));
    await expect(
      fetchSessionEvents({
        endpoint: "https://c",
        apiKey: "k",
        sessionId: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/403/);
  });

  it("throws on an invalid payload", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ nope: true }]));
    await expect(
      fetchSessionEvents({
        endpoint: "https://c",
        apiKey: "k",
        sessionId: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/invalid session payload/);
  });
});

describe("fetchSessionEventsStream", () => {
  it("negotiates NDJSON and yields each validated line", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse([`${JSON.stringify(camera(100))}\n`, `${JSON.stringify(camera(200))}\n`]),
    );
    const events = await collect(
      fetchSessionEventsStream({
        endpoint: "https://collect.example.com",
        apiKey: "k",
        sessionId: "abc/def",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://collect.example.com/api/v1/sessions/abc%2Fdef/events?format=ndjson",
      { headers: { "x-api-key": "k", accept: "application/x-ndjson" } },
    );
    expect(events.map((e) => e.ts)).toEqual([100, 200]);
  });

  it("handles lines split across chunks and a final line without a trailing newline", async () => {
    const line1 = JSON.stringify(camera(100));
    const line2 = JSON.stringify(camera(200));
    // Split mid-line and omit the last newline.
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse([line1.slice(0, 5), `${line1.slice(5)}\n${line2}`]),
    );
    const events = await collect(
      fetchSessionEventsStream({
        endpoint: "https://c",
        apiKey: "k",
        sessionId: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(events.map((e) => e.ts)).toEqual([100, 200]);
  });

  it("skips and counts malformed / invalid lines without failing", async () => {
    const onMalformedLine = vi.fn();
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse([
        `${JSON.stringify(camera(100))}\n`,
        `not json\n`,
        `${JSON.stringify({ nope: true })}\n`,
        `${JSON.stringify(camera(200))}\n`,
      ]),
    );
    const events = await collect(
      fetchSessionEventsStream({
        endpoint: "https://c",
        apiKey: "k",
        sessionId: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onMalformedLine,
      }),
    );
    expect(events.map((e) => e.ts)).toEqual([100, 200]);
    expect(onMalformedLine).toHaveBeenCalledTimes(2);
    expect(onMalformedLine).toHaveBeenLastCalledWith(2);
  });

  it("falls back to a JSON array when the server ignores NDJSON negotiation", async () => {
    const fetchImpl = vi.fn(async () => arrayResponse([camera(200), camera(100)]));
    const events = await collect(
      fetchSessionEventsStream({
        endpoint: "https://c",
        apiKey: "k",
        sessionId: "s",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    // Array fallback is sorted by ts like fetchSessionEvents.
    expect(events.map((e) => e.ts)).toEqual([100, 200]);
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([], false, 403));
    await expect(
      collect(
        fetchSessionEventsStream({
          endpoint: "https://c",
          apiKey: "k",
          sessionId: "s",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ),
    ).rejects.toThrow(/403/);
  });
});
