/** A query-string parameter map. `undefined` values are omitted from the request. */
export type QueryParams = Record<string, string | number | undefined>;

/**
 * A minimal HTTP client over the collector API. It holds no business logic — it
 * is a thin transport that mirrors the dashboard's `CollectorApi` so an agent
 * reads the same aggregated results a human would (ADR 0005 / ADR 0017).
 *
 * `get` is the whole analytics surface: **events are read-only**, and nothing
 * here can write, alter or delete one (ADR 0051 §9). The three write methods
 * exist for exactly one caller — the metadata write tools of #310 (annotations,
 * glossary, saved analyses) — which the MCP server registers only when the key
 * holds `annotate`. They are optional so a hand-built read-only client is still
 * a valid `CollectorClient`; {@link writeTools} reports a clear error instead of
 * calling a method that is not there.
 */
export interface CollectorClient {
  get(path: string, params?: QueryParams): Promise<unknown>;
  /** Create a metadata row. Used only by the `annotate` write tools. */
  post?(path: string, body: unknown): Promise<unknown>;
  /** Upsert a metadata row (the glossary). Used only by the `annotate` write tools. */
  put?(path: string, body: unknown): Promise<unknown>;
  /** Delete a metadata row. Used only by the `annotate` write tools. */
  delete?(path: string): Promise<unknown>;
}

/**
 * The `(collectorUrl, apiKey)` pair a collector client binds to. Every consumer
 * (MCP, dashboard, demo) talks only to its **own** collector, authenticated with
 * its own project API key — nothing is sent to any third party (ADR 0003 / 0017).
 */
export interface CollectorClientConfig {
  /** Base URL of the consumer's Uptimizr collector (e.g. https://collect.example.com). */
  collectorUrl: string;
  /** Project API key (`x-api-key`) used for read requests. */
  apiKey: string;
}

/** Thrown when the collector responds with a non-2xx status. */
export class CollectorError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CollectorError";
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Build a collector client bound to one `(collectorUrl, apiKey)` pair.
 * `fetchImpl` is injectable for testing; it defaults to the global `fetch`.
 *
 * The write methods are the narrow metadata path of #310 and nothing else:
 * whether they are allowed at all is decided by the collector from the key's
 * capabilities (`403` without `annotate`), not here.
 */
export function createCollectorClient(
  config: CollectorClientConfig,
  fetchImpl: typeof fetch = fetch,
): CollectorClient {
  const base = ensureTrailingSlash(config.collectorUrl);
  const resolve = (path: string): URL => new URL(path.replace(/^\//, ""), base);

  /** Send a request and turn a non-2xx response into a {@link CollectorError}. */
  async function send(url: URL, init: RequestInit): Promise<unknown> {
    const res = await fetchImpl(url, {
      ...init,
      headers: { "x-api-key": config.apiKey, ...(init.headers as Record<string, string>) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CollectorError(body || res.statusText, res.status);
    }
    // A successful delete answers `204 No Content`, which has no body to parse.
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    async get(path: string, params: QueryParams = {}): Promise<unknown> {
      const url = resolve(path);
      for (const [key, value] of Object.entries(params)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
      return send(url, { method: "GET" });
    },
    async post(path: string, body: unknown): Promise<unknown> {
      return send(resolve(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async put(path: string, body: unknown): Promise<unknown> {
      return send(resolve(path), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async delete(path: string): Promise<unknown> {
      return send(resolve(path), { method: "DELETE" });
    },
  };
}
