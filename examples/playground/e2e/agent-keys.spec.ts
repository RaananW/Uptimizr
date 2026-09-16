import { expect, test, type APIRequestContext } from "@playwright/test";

import {
  API_KEY,
  COLLECTOR_URL,
  PROJECT_ID,
  QUERY_ONLY_API_KEY,
  QUERY_ONLY_KEY_ID,
  RAW_API_KEY,
  RAW_KEY_ID,
} from "./constants.js";
import { bootEngine, enableAllCapture, waitForEventTypes } from "./helpers/capture.js";

/**
 * Agent-scoped API keys, end to end (#309, sketch §G.2 / ADR 0051 §7).
 *
 * The unit tests cover the capability parsing and the route guards against a
 * fake store. What only a full-stack run can prove is that a key minted with a
 * capability **set** in the real DuckDB store (`e2e/seed.ts` uses the same
 * `createApiKey` path the `uptimizr new-key` CLI drives) resolves through the
 * live collector with those capabilities, and that the tightened raw-session
 * gate holds on the **retention-enabled** harness — the configuration where the
 * old behaviour would have let a plain `query` key read raw per-session events.
 *
 * The harness runs the collector with `ENABLE_RAW_SESSION_RETENTION=1`
 * (`playwright.config.ts`), so every assertion below is made with retention ON.
 * That is the interesting half of the matrix: retention OFF is covered by the
 * collector's endpoint tests, and here it would mask the capability check.
 */

interface WhoAmI {
  projectId: string;
  keyId: string;
  capabilities: string[];
  label: string | null;
  rateLimit: { max: number; windowMs: number };
  rateLimitSource: "key" | "default";
}

interface AuditRow {
  keyId: string;
  at: string;
  surface: string;
  toolOrPath: string;
  params: string;
  rowCount: number | null;
  durationMs: number;
  status: number;
}

function get(request: APIRequestContext, path: string, key: string) {
  return request.get(`${COLLECTOR_URL}${path}`, { headers: { "x-api-key": key } });
}

test("whoami reports each key's capability set", async ({ request }) => {
  const readOnly = await get(request, "/api/v1/whoami", QUERY_ONLY_API_KEY);
  expect(readOnly.status()).toBe(200);
  const readOnlyBody = (await readOnly.json()) as WhoAmI;
  expect(readOnlyBody).toMatchObject({
    projectId: PROJECT_ID,
    keyId: QUERY_ONLY_KEY_ID,
    capabilities: ["query"],
    label: "e2e-query-only-agent",
    rateLimitSource: "default",
  });
  // The key itself is never echoed back — only its id.
  expect(await readOnly.text()).not.toContain(QUERY_ONLY_API_KEY);

  const raw = await get(request, "/api/v1/whoami", RAW_API_KEY);
  expect(raw.status()).toBe(200);
  expect((await raw.json()) as WhoAmI).toMatchObject({
    keyId: RAW_KEY_ID,
    capabilities: ["query", "query:raw"],
    label: "e2e-replay-agent",
  });

  // An unknown key is rejected outright.
  expect((await get(request, "/api/v1/whoami", "utk_not_a_key")).status()).toBe(401);
});

test("raw session stream requires query:raw even with retention enabled", async ({
  page,
  request,
}) => {
  // A real captured session, so the endpoint has something to refuse/return.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await waitForEventTypes(request, sessionId, ["session_start"]);

  // The collector runs with retention ON here, so retention is not what is
  // being tested — the capability is.
  const retentionProof = await get(request, `/api/v1/sessions/${sessionId}/events`, RAW_API_KEY);
  expect(
    retentionProof.status(),
    "the harness must run with ENABLE_RAW_SESSION_RETENTION=1 for this spec to mean anything",
  ).toBe(200);
  expect((await retentionProof.json()) as unknown[]).not.toHaveLength(0);

  // …and the same request with a `query`-only key is refused. This is the
  // deliberate tightening in #309: before it, retention alone was enough.
  const refused = await get(request, `/api/v1/sessions/${sessionId}/events`, QUERY_ONLY_API_KEY);
  expect(refused.status()).toBe(403);
  expect((await refused.json()) as { error: string }).toEqual({
    error: "api key not permitted to read raw session data",
  });

  // NDJSON negotiation is gated identically — the capability check precedes the
  // content negotiation, so there is no second way in.
  const refusedNdjson = await request.get(
    `${COLLECTOR_URL}/api/v1/sessions/${sessionId}/events?format=ndjson`,
    { headers: { "x-api-key": QUERY_ONLY_API_KEY, accept: "application/x-ndjson" } },
  );
  expect(refusedNdjson.status()).toBe(403);

  // Aggregate reads stay open to the `query`-only key: the tightening is scoped
  // to raw per-session data, not to the analytics API.
  const aggregate = await get(request, "/api/v1/sessions?limit=5", QUERY_ONLY_API_KEY);
  expect(aggregate.status()).toBe(200);
});

test("the live per-session follow honours query:raw through the live token", async ({
  request,
}) => {
  // `EventSource` cannot send `x-api-key`, so the per-session live tail reads the
  // capability set from the signed live token instead. Minting with a
  // `query`-only key must therefore produce a token that cannot follow a session.
  const mint = async (key: string): Promise<string> => {
    const res = await request.post(`${COLLECTOR_URL}/api/v1/live/token`, {
      headers: { "x-api-key": key },
    });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { token: string }).token;
  };

  const queryToken = await mint(QUERY_ONLY_API_KEY);
  const refused = await request.get(
    `${COLLECTOR_URL}/api/v1/live/sessions/any-session?token=${encodeURIComponent(queryToken)}`,
  );
  expect(refused.status()).toBe(403);
  expect((await refused.json()) as { error: string }).toEqual({
    error: "api key not permitted to read raw session data",
  });

  // The presence feed is aggregate and privacy-safe, so the same token works there.
  const presence = await request.get(
    `${COLLECTOR_URL}/api/v1/live/presence?token=${encodeURIComponent(queryToken)}`,
    { headers: { accept: "text/event-stream" }, timeout: 5_000 },
  );
  expect(presence.status()).toBe(200);
  presence.dispose();
});

test("an audit row appears after an agent query, and carries no key material", async ({
  request,
}) => {
  // A distinctive request to look for in the trail.
  const marker = 7;
  const read = await get(request, `/api/v1/sessions?limit=${marker}`, RAW_API_KEY);
  expect(read.status()).toBe(200);

  // The audit write is deliberately asynchronous (it must never block the
  // response), so poll briefly rather than assuming it has landed.
  let rows: AuditRow[] = [];
  await expect
    .poll(
      async () => {
        const res = await get(request, "/api/v1/audit?limit=50", API_KEY);
        expect(res.status()).toBe(200);
        rows = (await res.json()) as AuditRow[];
        return rows.filter(
          (row) => row.toolOrPath === "/api/v1/sessions" && row.params.includes(`${marker}`),
        ).length;
      },
      { timeout: 10_000, message: "an audit row should be written for the agent's read" },
    )
    .toBeGreaterThan(0);

  const row = rows.find(
    (r) => r.toolOrPath === "/api/v1/sessions" && r.params.includes(`${marker}`),
  )!;
  expect(row).toMatchObject({
    keyId: RAW_KEY_ID,
    surface: "http",
    toolOrPath: "/api/v1/sessions",
    status: 200,
  });
  expect(row.params).toBe(`{"limit":${marker}}`);
  expect(row.durationMs).toBeGreaterThanOrEqual(0);
  expect(new Date(row.at).getTime()).toBeGreaterThan(0);

  // No row anywhere in the trail may contain a plaintext key.
  const serialized = JSON.stringify(rows);
  for (const key of [API_KEY, QUERY_ONLY_API_KEY, RAW_API_KEY]) {
    expect(serialized).not.toContain(key);
  }

  // The refusal above is recorded too — a 403 is exactly what an owner wants to
  // see in an audit trail.
  await get(request, "/api/v1/sessions/no-such-session/events", QUERY_ONLY_API_KEY);
  await expect
    .poll(
      async () => {
        const res = await get(request, "/api/v1/audit?limit=50", API_KEY);
        const trail = (await res.json()) as AuditRow[];
        return trail.some(
          (r) => r.toolOrPath === "/api/v1/sessions/:id/events" && r.status === 403,
        );
      },
      { timeout: 10_000, message: "a refused raw read should be audited" },
    )
    .toBe(true);
});
