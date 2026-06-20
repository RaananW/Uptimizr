/* eslint-disable no-undef */
/**
 * Uptimizr demo service worker — the backend-less collector shim.
 *
 * It makes `demo.uptimizr.com` work with the *unmodified* dashboard and
 * playground by intercepting the collector's HTTP surface (`/api/v1/*`,
 * `/health`) and forwarding each request to the demo page, where DuckDB-Wasm
 * actually runs. Everything else is served cache-first so the demo keeps working
 * offline once "Prepare demo" has primed the cache.
 *
 * No analytics logic lives here: the worker is a pure transport + cache. The
 * store (schema, queries, retention) lives in the page (see store/host.ts).
 */

const CACHE = "uptimizr-demo-v2";

// The single public project the demo exposes. Served to the dashboard's project
// registry (`/api/projects`) so it preselects the project and its read key with
// no manual entry. Mirrors `src/store/constants.ts`.
const DEMO_PROJECTS = [{ id: "demo", name: "Uptimizr Demo", apiKey: "demo-read-key" }];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop stale caches from older deploys.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "uptimizr-precache" && Array.isArray(data.urls)) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE);
        // Cache each asset independently so one failure doesn't abort the batch.
        await Promise.all(
          data.urls.map(async (url) => {
            try {
              await cache.add(new Request(url, { cache: "reload" }));
            } catch {
              /* a missing optional asset must not break preparation */
            }
          }),
        );
        const port = event.ports && event.ports[0];
        if (port) port.postMessage({ ok: true });
      })(),
    );
  }
});

/** Is this request part of the collector HTTP surface we emulate? */
function isCollectorRequest(url) {
  return url.pathname.startsWith("/api/v1/") || url.pathname === "/health";
}

/**
 * The dashboard's project picker is fed by `/api/projects` (a Next route that a
 * static export bakes to `[]`). The demo answers it here so the picker resolves
 * to the single demo project without the operator pasting a key.
 */
function isProjectRegistryRequest(url) {
  return url.pathname === "/api/projects" || url.pathname === "/dashboard/api/projects";
}

/** Find the top demo page (the store host) among window clients. */
async function findHost() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // The host is the app root, never one of the embedded iframes.
  return (
    clients.find((c) => {
      const p = new URL(c.url).pathname;
      return !p.startsWith("/playground") && !p.startsWith("/dashboard");
    }) ?? null
  );
}

/** Forward a collector request to the page host and await its JSON reply. */
async function delegateToHost(request) {
  const host = await findHost();
  if (!host) {
    return new Response(JSON.stringify({ error: "demo store not ready" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const payload = { method: request.method, url: request.url, body };

  const reply = await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({ status: 504, body: { error: "store timeout" } }), 15000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    host.postMessage({ type: "uptimizr-request", request: payload }, [channel.port2]);
  });

  return new Response(JSON.stringify(reply.body ?? null), {
    status: reply.status ?? 200,
    headers: { "content-type": reply.contentType ?? "application/json; charset=utf-8" },
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle our own origin.
  if (url.origin !== self.location.origin) return;

  if (isProjectRegistryRequest(url)) {
    event.respondWith(
      new Response(JSON.stringify(DEMO_PROJECTS), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    return;
  }

  if (isCollectorRequest(url)) {
    event.respondWith(delegateToHost(request));
    return;
  }

  if (request.method !== "GET") return;

  // Stale-while-revalidate for the app shell + embeds + wasm assets: serve from
  // cache instantly (offline-capable) and refresh in the background.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === "basic") {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    })(),
  );
});
