import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Regression guard for the demo service worker's stale-while-revalidate handler
 * (`public/sw.js`).
 *
 * The SWR branch used to return `cached ?? network`, where `network` fell back to
 * the (possibly `undefined`) cache entry when `fetch()` rejected. A `fetch` is
 * rejected not only when offline but whenever an in-flight request is aborted —
 * which happens routinely when the user switches views (e.g. into a session
 * view). On a cache miss that yielded `respondWith(undefined)`, which throws
 * "Failed to convert value to 'Response'" and fails the resource load, stalling
 * the viewer. The handler must therefore *always* resolve to a `Response`.
 *
 * We execute the real `sw.js` inside a minimal mocked ServiceWorkerGlobalScope so
 * the assertion tracks the shipped file rather than a copy.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SW_PATH = resolve(here, "../public/sw.js");

const ORIGIN = "https://demo.uptimizr.com";

interface SwState {
  fetch: (request: Request) => Promise<Response>;
  cacheMatch: (request: Request) => Promise<Response | undefined>;
}

function loadServiceWorker() {
  const state: SwState = {
    fetch: () => Promise.reject(new Error("no fetch configured")),
    cacheMatch: () => Promise.resolve(undefined),
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
    caches: { open: async () => cache, keys: async () => [], delete: async () => {} },
    fetch: (request: Request) => state.fetch(request),
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

  return { state, dispatchFetch };
}

describe("demo service worker — SWR handler always resolves to a Response", () => {
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

  it("serves the cached response instantly even when revalidation rejects", async () => {
    const cached = new Response("cached-body", { status: 200 });
    sw.state.cacheMatch = async () => cached;
    sw.state.fetch = () => Promise.reject(new Error("offline"));

    const response = await sw.dispatchFetch(`${ORIGIN}/dashboard/index.html`);

    expect(response).toBe(cached);
  });

  it("returns the network response on a cache miss when fetch succeeds", async () => {
    const fresh = new Response("fresh-body", { status: 200 });
    sw.state.cacheMatch = async () => undefined;
    sw.state.fetch = async () => fresh;

    const response = await sw.dispatchFetch(`${ORIGIN}/dashboard/index.html`);

    expect(response).toBe(fresh);
  });
});
