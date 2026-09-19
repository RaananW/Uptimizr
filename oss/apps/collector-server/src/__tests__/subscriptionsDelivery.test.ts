import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { SubscriptionFiring } from "@uptimizr/schema";
import type { SubscriptionRecord } from "@uptimizr/db";
import {
  WEBHOOK_BASE_BACKOFF_MS,
  WEBHOOK_MAX_ATTEMPTS,
  checkWebhookUrl,
  deliver,
  webhookTargetOf,
  wantsSse,
} from "../subscriptions/delivery.js";
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "../webhookSignature.js";

/**
 * Webhook delivery (#311, sketch §F.3): the allow-list that bounds egress, the
 * signature a receiver verifies over the raw body, and the retry policy.
 *
 * The signature cases run against a **real local HTTP receiver** rather than a
 * fetch stub, because the thing being asserted is that the bytes on the wire are
 * the bytes that were signed — a stub that hands back the body it was given
 * cannot fail that test.
 */

const SECRET = "shhh-a-long-enough-secret";

const firing: SubscriptionFiring = {
  subscriptionId: "sub_1",
  name: "FPS drop",
  metric: "perf_summary",
  predicate: "threshold",
  at: 1_700_000_000_000,
  window: { since: 1_699_996_400_000, until: 1_700_000_000_000 },
  value: 28.5,
  expected: 40,
  sampleSize: 420,
  scene: "lobby",
  reason: "perf_summary.p50_fps is 28.5 — < 40 over 1h",
  dimensionValue: null,
};

function subscription(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: "sub_1",
    projectId: "p1",
    name: "FPS drop",
    metric: "perf_summary",
    filters: {},
    evaluate: { every: "5m", window: "1h" },
    predicate: { kind: "threshold", column: "p50_fps", op: "<", value: 40 },
    cooldown: "1h",
    delivery: [{ kind: "sse" }],
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastFiredAt: null,
    lastError: null,
    failures: 0,
    ...overrides,
  };
}

/** A local receiver capturing what it was sent. */
async function receiver(
  handler: (received: { body: string; headers: Record<string, string> }) => number,
): Promise<{
  url: string;
  server: Server;
  received: { body: string; headers: Record<string, string> }[];
}> {
  const received: { body: string; headers: Record<string, string> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry = {
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers as Record<string, string>,
      };
      received.push(entry);
      res.writeHead(handler(entry)).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address != null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/hook`, server, received };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe("checkWebhookUrl", () => {
  it("refuses everything while the allow-list is empty (the default)", () => {
    const result = checkWebhookUrl("https://hooks.example/x", []);
    expect("refused" in result && result.refused).toContain("COLLECTOR_WEBHOOK_ALLOWED_HOSTS");
  });

  it("refuses a non-http(s) scheme even when the host is allow-listed", () => {
    expect(checkWebhookUrl("file:///etc/passwd", ["*"])).toHaveProperty("refused");
    expect(checkWebhookUrl("gopher://evil/x", ["*"])).toHaveProperty("refused");
  });

  it("matches on hostname, case- and port-insensitively", () => {
    expect(checkWebhookUrl("https://Hooks.Example:8443/x", ["hooks.example"])).toHaveProperty(
      "url",
    );
    expect(checkWebhookUrl("https://evil.example/x", ["hooks.example"])).toHaveProperty("refused");
  });

  it("honours the explicit `*` opt-out", () => {
    expect(checkWebhookUrl("http://10.0.0.5/x", ["*"])).toHaveProperty("url");
  });
});

describe("deliver", () => {
  it("makes no outbound request at all when no webhook is configured", async () => {
    const seen: SubscriptionFiring[] = [];
    let fetched = 0;
    const outcome = await deliver(subscription(), firing, null, {
      broadcast: (f) => seen.push(f),
      secret: null,
      allowedHosts: ["*"],
      fetchImpl: (async () => {
        fetched += 1;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ ok: true, error: null, attempts: 0, egress: false });
    expect(fetched).toBe(0);
    expect(seen).toEqual([firing]);
  });

  it("signs the exact bytes it sends, and the receiver can verify them", async () => {
    const r = await receiver(() => 200);
    servers.push(r.server);

    const summary = { metric: "insight_baseline", rows: [] };
    const outcome = await deliver(
      subscription({ delivery: [{ kind: "webhook", url: r.url }] }),
      firing,
      summary,
      { broadcast: () => {}, secret: SECRET, allowedHosts: ["127.0.0.1"] },
    );

    expect(outcome).toMatchObject({ ok: true, error: null, attempts: 1, egress: true });
    expect(r.received).toHaveLength(1);
    const sent = r.received[0]!;
    const header = sent.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] as string;
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(SECRET, sent.body, header)).toBe(true);
    // The wrong secret must not verify, or the header proves nothing.
    expect(verifyWebhookSignature("other-secret", sent.body, header)).toBe(false);
    expect(sent.headers["x-uptimizr-delivery"]).toBeTruthy();
    expect(JSON.parse(sent.body)).toEqual({
      type: "subscription.firing",
      firing,
      summary,
    });
  });

  it("refuses a host that is not allow-listed without sending anything", async () => {
    const r = await receiver(() => 200);
    servers.push(r.server);

    const outcome = await deliver(
      subscription({ delivery: [{ kind: "webhook", url: r.url }] }),
      firing,
      null,
      { broadcast: () => {}, secret: SECRET, allowedHosts: ["hooks.example"] },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.egress).toBe(false);
    expect(outcome.error).toContain("not allow-listed");
    expect(r.received).toHaveLength(0);
  });

  it("retries a 500 with doubling backoff, then gives up", async () => {
    const r = await receiver(() => 500);
    servers.push(r.server);
    const slept: number[] = [];

    const outcome = await deliver(
      subscription({ delivery: [{ kind: "webhook", url: r.url }] }),
      firing,
      null,
      {
        broadcast: () => {},
        secret: SECRET,
        allowedHosts: ["127.0.0.1"],
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(outcome.error).toContain("500");
    expect(r.received).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect(slept).toEqual([WEBHOOK_BASE_BACKOFF_MS, WEBHOOK_BASE_BACKOFF_MS * 2]);
  });

  it("succeeds on a retry after a transient failure", async () => {
    let calls = 0;
    const r = await receiver(() => (++calls === 1 ? 503 : 204));
    servers.push(r.server);

    const outcome = await deliver(
      subscription({ delivery: [{ kind: "webhook", url: r.url }] }),
      firing,
      null,
      { broadcast: () => {}, secret: SECRET, allowedHosts: ["127.0.0.1"], sleep: async () => {} },
    );

    expect(outcome).toMatchObject({ ok: true, attempts: 2, egress: true });
  });

  it("does not retry a 4xx the receiver will reject again", async () => {
    const r = await receiver(() => 400);
    servers.push(r.server);

    const outcome = await deliver(
      subscription({ delivery: [{ kind: "webhook", url: r.url }] }),
      firing,
      null,
      { broadcast: () => {}, secret: SECRET, allowedHosts: ["127.0.0.1"], sleep: async () => {} },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(1);
    expect(r.received).toHaveLength(1);
  });

  it("still fans out over SSE when the webhook fails", async () => {
    const r = await receiver(() => 500);
    servers.push(r.server);
    const seen: SubscriptionFiring[] = [];

    await deliver(
      subscription({ delivery: [{ kind: "sse" }, { kind: "webhook", url: r.url }] }),
      firing,
      null,
      {
        broadcast: (f) => seen.push(f),
        secret: SECRET,
        allowedHosts: ["127.0.0.1"],
        sleep: async () => {},
      },
    );

    expect(seen).toEqual([firing]);
  });

  it("sends an unsigned body when the subscription carries no secret", async () => {
    const r = await receiver(() => 200);
    servers.push(r.server);

    await deliver(subscription({ delivery: [{ kind: "webhook", url: r.url }] }), firing, null, {
      broadcast: () => {},
      secret: null,
      allowedHosts: ["127.0.0.1"],
    });

    expect(r.received[0]?.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()]).toBeUndefined();
  });
});

describe("delivery target helpers", () => {
  it("reads the single webhook target and the sse flag", () => {
    expect(webhookTargetOf(subscription())).toBeNull();
    expect(wantsSse(subscription())).toBe(true);
    const withHook = subscription({ delivery: [{ kind: "webhook", url: "https://x.test/h" }] });
    expect(webhookTargetOf(withHook)?.url).toBe("https://x.test/h");
    expect(wantsSse(withHook)).toBe(false);
  });
});
