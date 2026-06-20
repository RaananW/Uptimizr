import { z } from "zod";
import { anyEventSchema, type AnyEvent } from "@uptimizr/schema";

export interface FetchSessionOptions {
  /** Collector base URL, e.g. `https://collect.example.com`. */
  endpoint: string;
  /** Project API key (sent as `x-api-key`). */
  apiKey: string;
  /** Session id to fetch. */
  sessionId: string;
  /** Override the global `fetch` (for testing or non-browser hosts). */
  fetchImpl?: typeof fetch;
}

const sessionPayloadSchema = z.array(anyEventSchema);

/**
 * Fetch the ordered event stream for a session from the collector's replay
 * endpoint (`GET /api/v1/sessions/:id/events`). Validates the payload against the
 * schema and returns events sorted by timestamp, ready for {@link ReplayPlayer}.
 */
export async function fetchSessionEvents(options: FetchSessionOptions): Promise<AnyEvent[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.endpoint}/api/v1/sessions/${encodeURIComponent(options.sessionId)}/events`;
  const res = await fetchImpl(url, { headers: { "x-api-key": options.apiKey } });
  if (!res.ok) {
    throw new Error(`replay fetch failed: ${res.status}`);
  }
  const parsed = sessionPayloadSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error("replay fetch returned an invalid session payload");
  }
  return parsed.data.sort((a, b) => a.ts - b.ts);
}

/** Optional hooks for the streaming fetch. */
export interface StreamSessionOptions extends FetchSessionOptions {
  /**
   * Called for each line that fails to parse/validate (skipped, not fatal), so
   * callers can surface or count malformed rows. The count is cumulative.
   */
  onMalformedLine?: (count: number) => void;
}

/**
 * Streaming counterpart to {@link fetchSessionEvents}: yields events as they
 * arrive instead of buffering the whole session, so playback can start before
 * the full stream has downloaded and neither side holds the entire session at
 * once (ADR 0015).
 *
 * Negotiates NDJSON via `Accept: application/x-ndjson` (and a `?format=ndjson`
 * hint). A collector that supports it streams one event per line, validated
 * per-line — a malformed line is skipped (and reported via `onMalformedLine`)
 * rather than failing the whole fetch. A collector that does **not** support
 * NDJSON returns the buffered JSON array, which is transparently parsed and
 * yielded, so this works against old and new servers alike.
 *
 * Events are yielded in server order (`ts ASC`); {@link ReplayPlayer} also sorts
 * defensively, so ordering is guaranteed regardless of transport.
 */
export async function* fetchSessionEventsStream(
  options: StreamSessionOptions,
): AsyncGenerator<AnyEvent> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `${options.endpoint}/api/v1/sessions/${encodeURIComponent(options.sessionId)}/events`;
  const res = await fetchImpl(`${base}?format=ndjson`, {
    headers: { "x-api-key": options.apiKey, accept: "application/x-ndjson" },
  });
  if (!res.ok) {
    throw new Error(`replay fetch failed: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") ?? "";

  // Fallback: a server that ignored the negotiation returned the JSON array.
  if (!contentType.includes("application/x-ndjson")) {
    const parsed = sessionPayloadSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error("replay fetch returned an invalid session payload");
    }
    for (const event of parsed.data.sort((a, b) => a.ts - b.ts)) {
      yield event;
    }
    return;
  }

  if (!res.body) {
    throw new Error("replay stream returned no body");
  }

  let malformed = 0;
  const reportMalformed = () => options.onMalformedLine?.(++malformed);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleLine = function* (line: string): Generator<AnyEvent> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      reportMalformed();
      return;
    }
    const parsed = anyEventSchema.safeParse(json);
    if (parsed.success) {
      yield parsed.data;
    } else {
      reportMalformed();
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      yield* handleLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  // Flush any trailing line without a final newline.
  yield* handleLine(buffer);
}
