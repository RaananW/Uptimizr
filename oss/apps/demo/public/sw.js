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

const CACHE = "uptimizr-demo-v3";

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

/* ---------------------------------------------------------------------------
 * In-worker live bus (ADR 0032 §3) — the demo's stand-in for the collector's
 * server-side `liveBus` + `/api/v1/live/*` SSE routes. Because every event
 * batch flows through this worker as a `POST /api/v1/collect`, the worker can
 * fan each event out to open presence/firehose/session SSE streams itself —
 * no page round-trip needed. Mirrors `oss/apps/collector-server/src/liveBus.ts`
 * (roster, liveness window, activity buckets) and `routes/live.ts` (frame
 * shape: `event: <name>\ndata: <json>\n\n`). Nothing is persisted.
 * ------------------------------------------------------------------------- */

const LIVE_WINDOW_MS = 30_000; // liveness window (collector default)
const LIVE_TICK_MS = 3_000; // presence refresh + stream heartbeat cadence
const LIVE_BACKFILL_RING = 200; // per-session connect-time backfill ring
const DEFAULT_SCENE_ID = "default"; // mirrors @uptimizr/schema

const encoder = new TextEncoder();
/** sessionId -> { sessionId, visitorId, sceneId, startedAt, lastSeen } */
const liveRoster = new Map();
/** sessionId -> recent events (bounded ring) for live-follow backfill */
const liveRings = new Map();
const presenceControllers = new Set(); // ReadableStreamDefaultController set
const streamSubs = new Set(); // { types: Set<string>|null, controller }
const sessionSubs = new Map(); // sessionId -> Set<{ controller }>
let liveTimer = null;

function sseFrame(data, eventName) {
  return encoder.encode((eventName ? `event: ${eventName}\n` : "") + `data: ${data}\n\n`);
}

function liveActivityOf(lastSeen, at) {
  const age = at - lastSeen;
  if (age <= 3_000) return "active";
  if (age <= 15_000) return "recent";
  return "idle";
}

function pruneLive(at) {
  for (const [k, e] of liveRoster) {
    if (at - e.lastSeen > LIVE_WINDOW_MS) {
      liveRoster.delete(k);
      liveRings.delete(k);
    }
  }
}

function presenceSnapshot() {
  const at = Date.now();
  pruneLive(at);
  const visitors = new Set();
  const sessions = [];
  for (const e of liveRoster.values()) {
    visitors.add(e.visitorId);
    sessions.push({
      sessionId: e.sessionId,
      sceneId: e.sceneId,
      startedAt: e.startedAt,
      lastSeen: e.lastSeen,
      activity: liveActivityOf(e.lastSeen, at),
    });
  }
  sessions.sort((a, b) => b.lastSeen - a.lastSeen);
  return { activeSessions: sessions.length, activeVisitors: visitors.size, sessions };
}

function trackLive(ev, at) {
  const sessionId = ev.sessionId;
  if (!sessionId) return;
  if (ev.type === "session_end") {
    liveRoster.delete(sessionId);
    liveRings.delete(sessionId);
    return;
  }
  const existing = liveRoster.get(sessionId);
  if (existing) {
    existing.lastSeen = at;
    if (ev.sceneId) existing.sceneId = ev.sceneId;
    if (ev.visitorId) existing.visitorId = ev.visitorId;
  } else {
    liveRoster.set(sessionId, {
      sessionId,
      visitorId: ev.visitorId || sessionId,
      sceneId: ev.sceneId || DEFAULT_SCENE_ID,
      startedAt: at,
      lastSeen: at,
    });
  }
  const ring = liveRings.get(sessionId);
  if (ring) {
    ring.push(ev);
    if (ring.length > LIVE_BACKFILL_RING) ring.shift();
  } else {
    liveRings.set(sessionId, [ev]);
  }
}

function fanoutEvent(ev) {
  const data = JSON.stringify(ev);
  if (streamSubs.size) {
    const frame = sseFrame(data, "event");
    for (const s of streamSubs) {
      if (s.types && !s.types.has(ev.type)) continue;
      try {
        s.controller.enqueue(frame);
      } catch {
        /* a closed controller is cleaned up on cancel */
      }
    }
  }
  const set = sessionSubs.get(ev.sessionId);
  if (set && set.size) {
    const frame = sseFrame(data, "event");
    for (const s of set) {
      try {
        s.controller.enqueue(frame);
      } catch {
        /* ignore */
      }
    }
  }
}

function pushPresence() {
  if (presenceControllers.size === 0) return;
  const frame = sseFrame(JSON.stringify(presenceSnapshot()), "presence");
  for (const c of presenceControllers) {
    try {
      c.enqueue(frame);
    } catch {
      /* ignore */
    }
  }
}

/** Lazily run the presence-refresh + heartbeat ticker while any stream is open. */
function ensureLiveTimer() {
  if (liveTimer) return;
  liveTimer = setInterval(() => {
    if (presenceControllers.size === 0 && streamSubs.size === 0 && sessionSubs.size === 0) {
      clearInterval(liveTimer);
      liveTimer = null;
      return;
    }
    pushPresence();
    const ping = encoder.encode(": ping\n\n");
    for (const s of streamSubs) {
      try {
        s.controller.enqueue(ping);
      } catch {
        /* ignore */
      }
    }
    for (const set of sessionSubs.values()) {
      for (const s of set) {
        try {
          s.controller.enqueue(ping);
        } catch {
          /* ignore */
        }
      }
    }
  }, LIVE_TICK_MS);
}

/** Publish a `/api/v1/collect` batch to the live bus (roster + SSE fan-out). */
function publishToLiveBus(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return;
  }
  const events = parsed && parsed.events;
  if (!Array.isArray(events)) return;
  const at = Date.now();
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    trackLive(ev, at);
    fanoutEvent(ev);
  }
  pushPresence();
}

/** Build an SSE `Response` backed by a controller registered via `register`. */
function sseResponse(register, unregister) {
  let registered = null;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      registered = register(controller);
      ensureLiveTimer();
    },
    cancel() {
      unregister(registered);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/** SSE: aggregate presence roster — pushes a snapshot on connect, then ticks. */
function handlePresenceStream() {
  return sseResponse(
    (controller) => {
      presenceControllers.add(controller);
      controller.enqueue(sseFrame(JSON.stringify(presenceSnapshot()), "presence"));
      return controller;
    },
    (controller) => {
      if (controller) presenceControllers.delete(controller);
    },
  );
}

/** SSE: project firehose — every collected event (optionally type-filtered). */
function handleEventStream(url) {
  const raw = url.searchParams.get("types");
  const types = raw
    ? new Set(
        raw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      )
    : null;
  const sub = { types, controller: null };
  return sseResponse(
    (controller) => {
      sub.controller = controller;
      streamSubs.add(sub);
      return sub;
    },
    (s) => {
      if (s) streamSubs.delete(s);
    },
  );
}

/** SSE: per-session live-follow tail — connect-time backfill, then live events. */
function handleSessionStream(sessionId) {
  const sub = { controller: null };
  return sseResponse(
    (controller) => {
      sub.controller = controller;
      let set = sessionSubs.get(sessionId);
      if (!set) {
        set = new Set();
        sessionSubs.set(sessionId, set);
      }
      set.add(sub);
      const ring = liveRings.get(sessionId) || [];
      for (const ev of ring) controller.enqueue(sseFrame(JSON.stringify(ev), "event"));
      return sub;
    },
    (s) => {
      if (!s) return;
      const set = sessionSubs.get(sessionId);
      if (set) {
        set.delete(s);
        if (set.size === 0) sessionSubs.delete(sessionId);
      }
    },
  );
}

/** Tap a `/api/v1/collect` POST for the live bus, then forward it to the store. */
async function handleCollectWithLive(request) {
  try {
    publishToLiveBus(await request.clone().text());
  } catch {
    /* a malformed batch still gets forwarded for the store to reject */
  }
  return delegateToHost(request);
}

/** Is this one of the live SSE / token endpoints we serve in-worker? */
function liveRoute(url, method) {
  const p = url.pathname;
  if (method === "POST" && p === "/api/v1/live/token") return "token";
  if (method === "GET" && p === "/api/v1/live/presence") return "presence";
  if (method === "GET" && p === "/api/v1/live/stream") return "stream";
  if (method === "GET" && /^\/api\/v1\/live\/sessions\/[^/]+$/.test(p)) return "session";
  return null;
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
    // Live SSE + token endpoints are served entirely in-worker (ADR 0032 §3):
    // the worker is the single chokepoint every event batch flows through, so it
    // fans events out to open streams without a page round-trip.
    const live = liveRoute(url, request.method);
    if (live === "token") {
      event.respondWith(
        new Response(JSON.stringify({ token: "demo-live", expiresAt: Date.now() + 600_000 }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      );
      return;
    }
    if (live === "presence") {
      event.respondWith(handlePresenceStream());
      return;
    }
    if (live === "stream") {
      event.respondWith(handleEventStream(url));
      return;
    }
    if (live === "session") {
      const sessionId = decodeURIComponent(url.pathname.split("/").pop());
      event.respondWith(handleSessionStream(sessionId));
      return;
    }
    // Ingest: tap the batch for the live bus, then persist via the page store.
    if (request.method === "POST" && url.pathname === "/api/v1/collect") {
      event.respondWith(handleCollectWithLive(request));
      return;
    }
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
