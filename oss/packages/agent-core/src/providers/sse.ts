/**
 * A minimal, allocation-light Server-Sent Events (SSE) parser for the hosted
 * adapter's streamed completions (OpenAI-compatible and Anthropic both speak
 * `text/event-stream`).
 *
 * Model output flows through here, so — per the project's CodeQL ReDoS rule —
 * it uses **string membership and linear scans only**: `indexOf`, `startsWith`,
 * `slice`, and a hand-rolled line splitter. No regular expression ever touches
 * the payload. It handles the wire's edge cases explicitly:
 *   - a chunk boundary can fall anywhere (mid-line, mid-event); leftover bytes
 *     are carried over to the next `feed()`;
 *   - `\\n`, `\\r\\n` and bare `\\r` line endings;
 *   - multi-line `data:` fields (joined with `\\n`, per the SSE spec);
 *   - comment lines (`: keep-alive`) and unknown fields are ignored;
 *   - a trailing event with no blank line is flushed on `end()`.
 */

/** One parsed SSE event: its optional `event:` name and the joined `data:` payload. */
export interface SseEvent {
  event?: string;
  data: string;
}

/** Incremental SSE parser: feed text chunks, receive complete events. */
export interface SseParser {
  /** Feed the next decoded text chunk; complete events are dispatched in order. */
  feed(chunk: string): void;
  /** Signal end of stream: dispatches any buffered, unterminated event. */
  end(): void;
}

/** Strip one leading space after the field colon, per the SSE spec. */
function fieldValue(line: string, colon: number): string {
  const start = colon + 1;
  return line.charCodeAt(start) === 32 /* space */ ? line.slice(start + 1) : line.slice(start);
}

/** Create an incremental {@link SseParser} dispatching to `onEvent`. */
export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  function dispatch(): void {
    if (dataLines.length === 0 && eventName === undefined) return;
    if (dataLines.length > 0) {
      onEvent(
        eventName === undefined
          ? { data: dataLines.join("\n") }
          : { event: eventName, data: dataLines.join("\n") },
      );
    }
    eventName = undefined;
    dataLines = [];
  }

  function handleLine(line: string): void {
    if (line.length === 0) {
      dispatch();
      return;
    }
    // Comment line: ignore (keep-alives).
    if (line.charCodeAt(0) === 58 /* ':' */) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : fieldValue(line, colon);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
    // `id:` / `retry:` / unknown fields are irrelevant for a one-shot completion.
  }

  return {
    feed(chunk: string): void {
      buffer += chunk;
      let start = 0;
      const len = buffer.length;
      for (let i = 0; i < len; i++) {
        const code = buffer.charCodeAt(i);
        if (code === 10 /* \n */) {
          handleLine(buffer.slice(start, i));
          start = i + 1;
        } else if (code === 13 /* \r */) {
          handleLine(buffer.slice(start, i));
          // Treat "\r\n" as one terminator; a bare "\r" also ends the line.
          if (i + 1 < len && buffer.charCodeAt(i + 1) === 10) i++;
          start = i + 1;
        }
      }
      buffer = start === 0 ? buffer : buffer.slice(start);
      // A trailing lone "\r" could be the first half of "\r\n" split across
      // chunks; it is kept in the buffer and resolved on the next feed/end.
    },
    end(): void {
      if (buffer.length > 0) {
        handleLine(buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

/**
 * Read a `ReadableStream<Uint8Array>` (a `fetch` response body) to completion,
 * decoding UTF-8 incrementally (multi-byte characters split across reads are
 * handled by the streaming `TextDecoder`) and dispatching every SSE event to
 * `onEvent`. Resolves when the stream ends; rejects on a read error or when
 * `signal` aborts (the reader is cancelled so the connection is released).
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = createSseParser(onEvent);
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    parser.end();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** The `AbortError` a cancelled stream rejects with (matches `fetch`'s). */
export function abortError(): Error {
  return typeof DOMException !== "undefined"
    ? new DOMException("The operation was aborted.", "AbortError")
    : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}
