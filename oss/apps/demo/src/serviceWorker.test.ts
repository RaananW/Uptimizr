import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Behavior guards for the demo service worker's GET caching (`public/sw.js`).
 *
 * The worker splits GET handling by request type so a fresh Vercel deploy is
 * never masked by the cache:
 *   - HTML documents (the app shell) → NETWORK-FIRST: use the fresh network copy,
 *     fall back to cache only when offline. (Previously stale-while-revalidate,
 *     which pinned returning users to an old build + its old hashed chunks.)
 *   - content-hashed / immutable assets (`/assets/`, `/_next/static/`, `*.wasm`)
 *     → CACHE-FIRST: safe because the URL changes when the content changes.
 *   - remaining non-hashed assets → stale-while-revalidate.
 *
 * Every branch must *always* resolve to a `Response`: the SWR branch used to
 * return `cached ?? network`, where `network` fell back to the (possibly
 * `undefined`) cache entry when `fetch()` rejected. A `fetch` is rejected not
 * only when offline but whenever an in-flight request is aborted — which happens
 * routinely when the user switches views. On a cache miss that yielded
 * `respondWith(undefined)`, throwing "Failed to convert value to 'Response'" and
 * stalling the viewer.
 *
 * We execute the real `sw.js` inside a minimal mocked ServiceWorkerGlobalScope so
 * the assertions track the shipped file rather than a copy.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SW_PATH = resolve(here, "../public/sw.js");

const ORIGIN = "https://demo.uptimizr.com";

interface SwState {
  fetch: (request: Request) => Promise<Response>;
  cacheMatch: (request: Request) => Promise<Response | undefined>;
  cacheKeys: string[];
  deleted: string[];
  fetchCount: number;
}

function loadServiceWorker() {
  const state: SwState = {
    fetch: () => Promise.reject(new Error("no fetch configured")),
    cacheMatch: () => Promise.resolve(undefined),
    cacheKeys: [],
    deleted: [],
    fetchCount: 0,
  };
  const handlers: Record<string, (event: unknown) => void> = {};

  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers[type] = fn;
    },
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
    location: { origin: ORIGIN },
  };

  const cache = {
    match: (request: Request) => state.cacheMatch(request),
    put: async () => {},
    add: async () => {},
  };

  const context: Record<string, unknown> = {
    self,
    caches: {
      open: async () => cache,
      keys: async () => state.cacheKeys,
      delete: async (key: string) => {
        state.deleted.push(key);
      },
    },
    fetch: (request: Request) => {
      state.fetchCount += 1;
      return state.fetch(request);
    },
    Response,
    Request,
    URL,
    ReadableStream,
    TextEncoder,
    MessageChannel,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(SW_PATH, "utf8"), context, { filename: "sw.js" });

  async function dispatchFetch(url: string, init?: RequestInit): Promise<Response | undefined> {
    const request = new Request(url, init);
    let responded: Promise<Response> | undefined;
    handlers.fetch?.({ request, respondWith: (value: Promise<Response>) => (responded = value) });
    return responded;
  }

  async function dispatchActivate(): Promise<void> {
    let work: Promise<unknown> | undefined;
    handlers.activate?.({ waitUntil: (value: Promise<unknown>) => (work = value) });
    await work;
  }

  return { state, dispatchFetch, dispatchActivate };
}

describe("demo service worker — every GET branch resolves to a Response", () => {
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it("returns a Response when the fetch is aborted/rejected on a cache miss", async () => {
    sw.state.cacheMatch = async () => undefined;
    sw.state.fetch = () => Promise.reject(new DOMException("aborted", "AbortError"));

    const response = await sw.dispatchFetch(`${ORIGIN}/dashboard/_next/static/chunk.js`);

    // The regression: this used to be `undefined`, throwing
    // "Failed to convert value to 'Response'" inside respondWith.
    expect(response).toBeInstanceOf(Response);
  });
});

describe("demo service worker — HTML app shell is network-first", () => {
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it("serves the fresh network document over a cached one when online", async () => {
    const cached = new Response("stale-shell", { status: 200 });
    const fresh = new Response("fresh-shell", { status: 200 });
    sw.state.cacheMatch = async () => cached;
    sw.state.fetch = async () => fresh;

    // A real navigation carries `Accept: text/html`; the worker must NOT serve the
    // cached shell (which would mask a new deploy).
    const response = await sw.dispatchFetch(`${ORIGIN}/dashboard/index.html`, {
      headers: { accept: "text/html" },
    });

    expect(response).toBe(fresh);
  });

  it("falls back to the cached document when the network fails (offline)", async () => {
    const cached = new Response("cached-shell", { status: 200 });
    sw.state.cacheMatch = async () => cached;
    sw.state.fetch = () => Promise.reject(new Error("offline"));

    const response = await sw.dispatchFetch(`${ORIGIN}/`, {
      headers: { accept: "text/html" },
    });

    expect(response).toBe(cached);
  });

  it("returns the network document on a cache miss when the network succeeds", async () => {
    const fresh = new Response("fresh-shell", { status: 200 });
    sw.state.cacheMatch = async () => undefined;
    sw.state.fetch = async () => fresh;

    const response = await sw.dispatchFetch(`${ORIGIN}/dashboard/index.html`);

    expect(response).toBe(fresh);
  });
});

describe("demo service worker — content-hashed assets are cache-first", () => {
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  for (const path of [
    "/assets/index-abc123.js",
    "/playground/assets/main-def456.css",
    "/dashboard/_next/static/chunk-789.js",
    "/assets/duckdb-eh-0a1b2c.wasm",
  ]) {
    it(`serves ${path} from cache without touching the network`, async () => {
      const cached = new Response("hashed-asset", { status: 200 });
      sw.state.cacheMatch = async () => cached;
      sw.state.fetch = () => Promise.reject(new Error("network must not be used"));

      const response = await sw.dispatchFetch(`${ORIGIN}${path}`);

      expect(response).toBe(cached);
      expect(sw.state.fetchCount).toBe(0);
    });
  }

  it("fetches and returns a hashed asset on a cache miss", async () => {
    const fresh = new Response("hashed-asset", { status: 200 });
    sw.state.cacheMatch = async () => undefined;
    sw.state.fetch = async () => fresh;

    const response = await sw.dispatchFetch(`${ORIGIN}/assets/index-abc123.js`);

    expect(response).toBe(fresh);
    expect(sw.state.fetchCount).toBe(1);
  });
});

describe("demo service worker — cache version + eviction", () => {
  const source = readFileSync(SW_PATH, "utf8");

  it("bumped the cache constant to v4 and dropped v3", () => {
    expect(source.includes('"uptimizr-demo-v4"')).toBe(true);
    expect(source.includes("uptimizr-demo-v3")).toBe(false);
  });

  it("activate purges every cache except the current one", async () => {
    const sw = loadServiceWorker();
    sw.state.cacheKeys = ["uptimizr-demo-v3", "uptimizr-demo-v4", "some-other-cache"];

    await sw.dispatchActivate();

    expect(sw.state.deleted).toContain("uptimizr-demo-v3");
    expect(sw.state.deleted).toContain("some-other-cache");
    expect(sw.state.deleted).not.toContain("uptimizr-demo-v4");
  });
});
