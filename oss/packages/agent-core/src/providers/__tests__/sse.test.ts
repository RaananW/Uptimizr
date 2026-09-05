import { describe, expect, it } from "vitest";
import { createSseParser, readSseStream, type SseEvent } from "../sse.js";

/** Feed a list of chunks through a parser and collect every dispatched event. */
function parse(chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser((e) => events.push(e));
  for (const chunk of chunks) parser.feed(chunk);
  parser.end();
  return events;
}

/** A `ReadableStream<Uint8Array>` that yields the given strings as separate reads. */
function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

describe("createSseParser", () => {
  it("parses complete events separated by blank lines", () => {
    expect(parse(["data: one\n\ndata: two\n\n"])).toEqual([{ data: "one" }, { data: "two" }]);
  });

  it("reassembles an event split anywhere across chunks", () => {
    // Split mid-field-name, mid-value, and between the two terminating newlines.
    expect(parse(["da", "ta: hel", "lo wor", "ld\n", "\n"])).toEqual([{ data: "hello world" }]);
  });

  it("carries the event name and joins multi-line data with newlines", () => {
    expect(parse(["event: message_start\ndata: {\ndata: }\n\n"])).toEqual([
      { event: "message_start", data: "{\n}" },
    ]);
  });

  it("accepts \\r\\n and bare \\r line endings, including a \\r\\n split across chunks", () => {
    expect(parse(["data: a\r\n\r\ndata: b\r\r"])).toEqual([{ data: "a" }, { data: "b" }]);
    expect(parse(["data: c\r", "\n\r\n"])).toEqual([{ data: "c" }]);
  });

  it("ignores comment lines and unknown fields, and keeps data without a leading space", () => {
    expect(parse([": keep-alive\nid: 7\nretry: 100\ndata:tight\n\n"])).toEqual([{ data: "tight" }]);
  });

  it("flushes a trailing event that has no terminating blank line on end()", () => {
    expect(parse(["data: [DONE]"])).toEqual([{ data: "[DONE]" }]);
  });

  it("dispatches nothing for an event with only a name and no data", () => {
    expect(parse(["event: ping\n\n"])).toEqual([]);
  });

  it("handles a pathological payload in linear time (no regex, no ReDoS)", () => {
    const start = Date.now();
    const colons = ":".repeat(200_000);
    const events = parse([`data: ${colons}\n\n`, `${"data: x\n".repeat(50_000)}\n`]);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(events[0]!.data).toBe(colons);
    expect(events[1]!.data.length).toBe(50_000 * 2 - 1);
  });
});

describe("readSseStream", () => {
  it("decodes UTF-8 incrementally, even when a multi-byte character is split across reads", async () => {
    const encoded = new TextEncoder().encode("data: héllo →\n\n");
    // Cut inside the two-byte "é" and the three-byte "→".
    const parts = [encoded.slice(0, 8), encoded.slice(8, 15), encoded.slice(15)];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < parts.length) controller.enqueue(parts[i++]!);
        else controller.close();
      },
    });
    const events: SseEvent[] = [];
    await readSseStream(body, (e) => events.push(e));
    expect(events).toEqual([{ data: "héllo →" }]);
  });

  it("rejects with an AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readSseStream(byteStream(["data: a\n\n"]), () => {}, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
