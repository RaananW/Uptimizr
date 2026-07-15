/** A query-string parameter map. `undefined` values are omitted from the request. */
export type QueryParams = Record<string, string | number | undefined>;

/**
 * A minimal **read-only** HTTP client over the collector query API. It performs
 * `GET` requests only and holds no business logic — it is a thin transport that
 * mirrors the dashboard's `CollectorApi` so an agent reads the same aggregated
 * results a human would (ADR 0005 / ADR 0017).
 */
export interface CollectorClient {
  get(path: string, params?: QueryParams): Promise<unknown>;
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
 * Build a read-only collector client bound to one `(collectorUrl, apiKey)` pair.
 * `fetchImpl` is injectable for testing; it defaults to the global `fetch`.
 */
export function createCollectorClient(
  config: CollectorClientConfig,
  fetchImpl: typeof fetch = fetch,
): CollectorClient {
  const base = ensureTrailingSlash(config.collectorUrl);
  return {
    async get(path: string, params: QueryParams = {}): Promise<unknown> {
      const url = new URL(path.replace(/^\//, ""), base);
      for (const [key, value] of Object.entries(params)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { "x-api-key": config.apiKey },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new CollectorError(body || res.statusText, res.status);
      }
      return res.json();
    },
  };
}
