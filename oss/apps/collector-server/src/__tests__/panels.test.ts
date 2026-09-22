import { describe, expect, it } from "vitest";
import type { ResolvedApiKey } from "@uptimizr/db";
import { LIMITS } from "@uptimizr/schema";
import { buildApp } from "../app.js";
import type { CollectorConfig } from "../config.js";
import { createMemoryStore } from "../memoryStore.js";
import type { CollectorStore } from "../store.js";

/**
 * Declarative panel specs over HTTP (#315, ADR 0051 §7 / sketch §G.3).
 *
 * What these tests hold the implementation to:
 *
 * - writes need `annotate`, reads need `query` — a read-only key is refused with
 *   403, not quietly ignored;
 * - the shape is bounded at the edge by `panelSpecV1Schema`, and the
 *   **vocabulary** by `validatePanelSpec`: a spec that would render a chart with
 *   nothing to draw is refused at pin time, with the validator's issue codes, so
 *   the client can fix it from the response;
 * - `range: "inherit"` survives the round trip (the panel follows the filter bar
 *   rather than freezing the window it was pinned at);
 * - the listing is oldest-first — these are grid positions, not a feed;
 * - an edit keeps the id and the original authorship;
 * - the per-project cap is enforced and answered as `409`;
 * - every write lands in the agent audit log;
 * - and nothing on this path inserts an event.
 */

const config: CollectorConfig = {
  host: "127.0.0.1",
  port: 0,
  corsOrigins: [],
  visitorHashSecret: "test-secret",
  enableRawSessionRetention: false,
  liveWindowMs: 30_000,
  liveTokenSecret: "test-live-secret",
  liveTokenSecretIsDedicated: true,
  liveTokenTtlMs: 900_000,
  liveMaxConnections: 200,
  livePresenceIntervalMs: 2_000,
  rateLimitMax: 1000,
  rateLimitWindowMs: 60_000,
  ingestRateLimitMax: 1000,
  ingestRateLimitWindowMs: 60_000,
  trustProxy: false,
  bodyLimit: 1_048_576,
  cspMode: "strict",
  auditRetentionDays: 30,
  auditDashboardRequests: false,
};

/** A writer key and a read-only key, both on the same project. */
const KEYS: Record<string, ResolvedApiKey> = {
  "annotate-key": {
    projectId: "p1",
    keyId: "k-annotate",
    capabilities: ["query", "annotate"],
    label: "weekly-report-agent",
    rateLimit: null,
  },
  "query-key": {
    projectId: "p1",
    keyId: "k-query",
    capabilities: ["query"],
    label: null,
    rateLimit: null,
  },
};

function makeStore(): CollectorStore {
  const base = createMemoryStore({
    projectId: "p1",
    apiKey: "annotate-key",
    capabilities: ["query", "annotate"],
    keyId: "k-annotate",
  });
  return { ...base, resolveApiKey: async (key: string) => KEYS[key] ?? null };
}

const writer = { "x-api-key": "annotate-key" };
const reader = { "x-api-key": "query-key" };
/** What the dashboard's own session sends — a *person* pinned the panel. */
const dashboard = { "x-api-key": "annotate-key", "x-uptimizr-client": "dashboard" };

async function makeApp() {
  return buildApp({ store: makeStore(), config });
}

/** A valid spec: a bar chart over the meshes people touch. */
function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    title: "Top meshes",
    chart: "bar",
    query: { v: 1, metric: "top_meshes", range: "inherit", limit: 10 },
    ...overrides,
  };
}

describe("pinning a panel", () => {
  it("stores a spec, lists it, and unpins it", async () => {
    const app = await makeApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/panels",
      headers: writer,
      payload: spec({
        note: "The crate outsells everything else three to one.",
        encoding: { x: "mesh", y: "count" },
      }),
    });
    expect(created.statusCode).toBe(201);
    const row = created.json();
    expect(row).toMatchObject({
      projectId: "p1",
      authorKind: "agent",
      authorKeyId: "k-annotate",
    });
    expect(typeof row.id).toBe("string");
    // The panel follows the filter bar rather than freezing the window it was
    // pinned at — that is what keeps it worth reading next week.
    expect(row.spec.query.range).toBe("inherit");
    expect(row.spec.span).toBe(1);
    expect(row.spec.note).toBe("The crate outsells everything else three to one.");

    const listed = await app.inject({ method: "GET", url: "/api/v1/panels", headers: reader });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/panels/${row.id}`,
      headers: writer,
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/panels", headers: reader })).json(),
    ).toEqual([]);
  });

  it("lists oldest first, so a new pin does not reshuffle the grid", async () => {
    const app = await makeApp();
    for (const title of ["First", "Second", "Third"]) {
      await app.inject({
        method: "POST",
        url: "/api/v1/panels",
        headers: writer,
        payload: spec({ title }),
      });
    }
    const listed = await app.inject({ method: "GET", url: "/api/v1/panels", headers: reader });
    expect(listed.json().map((row: { spec: { title: string } }) => row.spec.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("attributes a dashboard write to a person and everything else to an agent", async () => {
    const app = await makeApp();
    const byPerson = await app.inject({
      method: "POST",
      url: "/api/v1/panels",
      headers: dashboard,
      payload: spec(),
    });
    expect(byPerson.json().authorKind).toBe("user");
  });

  it("replaces a spec in place, keeping the id and the original author", async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/panels",
      headers: writer,
      payload: spec({ title: "Before" }),
    });
    const { id } = created.json();

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/panels/${id}`,
      headers: dashboard,
      payload: spec({ title: "After", span: 2, chart: "table" }),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().id).toBe(id);
    expect(updated.json().spec.title).toBe("After");
    expect(updated.json().spec.span).toBe(2);
    // An edit is not a new pin: whoever pinned it, pinned it.
    expect(updated.json().authorKind).toBe("agent");

    const listed = await app.inject({ method: "GET", url: "/api/v1/panels", headers: reader });
    expect(listed.json()).toHaveLength(1);
  });

  it("answers 404 for an unknown id on both write paths", async () => {
    const app = await makeApp();
    const missing = await app.inject({
      method: "PUT",
      url: "/api/v1/panels/no-such-id",
      headers: writer,
      payload: spec(),
    });
    expect(missing.statusCode).toBe(404);
    const gone = await app.inject({
      method: "DELETE",
      url: "/api/v1/panels/no-such-id",
      headers: writer,
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe("the capability gate", () => {
  it("lets a read-only key list panels but refuses it every write", async () => {
    const app = await makeApp();
    const pinned = await app.inject({
      method: "POST",
      url: "/api/v1/panels",
      headers: writer,
      payload: spec(),
    });
    const { id } = pinned.json();

    expect(
      (await app.inject({ method: "GET", url: "/api/v1/panels", headers: reader })).statusCode,
    ).toBe(200);

    const refusals = [
      app.inject({ method: "POST", url: "/api/v1/panels", headers: reader, payload: spec() }),
      app.inject({
        method: "PUT",
        url: `/api/v1/panels/${id}`,
        headers: reader,
        payload: spec({ title: "Hijacked" }),
      }),
      app.inject({ method: "DELETE", url: `/api/v1/panels/${id}`, headers: reader }),
    ];
    for (const res of await Promise.all(refusals)) {
      expect(res.statusCode).toBe(403);
    }

    // And nothing was written: the capability is the boundary.
    const listed = await app.inject({ method: "GET", url: "/api/v1/panels", headers: reader });
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0].spec.title).toBe("Top meshes");
  });

  it("refuses an unauthenticated request outright", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/panels" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/panels", payload: spec() })).statusCode,
    ).toBe(401);
  });
});

describe("what the edge refuses", () => {
  const post = (app: Awaited<ReturnType<typeof makeApp>>, payload: unknown) =>
    app.inject({ method: "POST", url: "/api/v1/panels", headers: writer, payload });

  it("rejects a malformed spec on shape alone", async () => {
    const app = await makeApp();
    // A chart the catalog cannot draw, a version that is not 1, an unknown key,
    // and a title past its bound.
    expect((await post(app, spec({ chart: "pie" }))).statusCode).toBe(400);
    expect((await post(app, spec({ v: 2 }))).statusCode).toBe(400);
    expect((await post(app, spec({ script: "alert(1)" }))).statusCode).toBe(400);
    expect(
      (await post(app, spec({ title: "x".repeat(LIMITS.maxPanelSpecTitleLength + 1) }))).statusCode,
    ).toBe(400);
  });

  it("rejects a spec whose query the registry cannot answer, naming the issue", async () => {
    const app = await makeApp();
    const res = await post(
      app,
      spec({ query: { v: 1, metric: "no_such_metric", range: "inherit" } }),
    );
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.issues.map((i: { code: string }) => i.code)).toEqual(["unknown_metric"]);
    expect(body.issues[0].path).toBe("query.metric");
    expect(body.error).toMatch(/cannot be pinned/);
  });

  it("rejects a chart the metric's grain cannot support, and says what would work", async () => {
    const app = await makeApp();
    // `top_meshes` is a ranking: there is no axis for a line to walk along.
    const res = await post(app, spec({ chart: "line" }));
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.issues[0].code).toBe("chart_grain_mismatch");
    expect(body.issues[0].path).toBe("chart");
    expect(body.issues[0].accepted).toContain("bar");
  });

  it("rejects an encoding column the metric's result does not carry", async () => {
    const app = await makeApp();
    const res = await post(app, spec({ encoding: { x: "mesh", y: "hits" } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].code).toBe("unknown_encoding_column");
    expect(res.json().issues[0].path).toBe("encoding.y");
  });

  it("applies the same vocabulary check to a replacement", async () => {
    const app = await makeApp();
    const created = await post(app, spec());
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/panels/${created.json().id}`,
      headers: writer,
      payload: spec({ chart: "world3d" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].code).toBe("chart_grain_mismatch");
  });

  it("answers 409 once the project is full, rather than growing without bound", async () => {
    const app = await makeApp();
    for (let i = 0; i < LIMITS.maxProjectPanelSpecs; i++) {
      const res = await post(app, spec({ title: `Panel ${i}` }));
      expect(res.statusCode, `pin ${i}`).toBe(201);
    }
    const full = await post(app, spec({ title: "One too many" }));
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toMatch(/limit of \d+ panelSpecs rows/);
  });
});

describe("panels on the audited, event-free write path", () => {
  it("records every write in the agent audit log", async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/panels",
      headers: writer,
      payload: spec(),
    });
    await app.inject({
      method: "DELETE",
      url: `/api/v1/panels/${created.json().id}`,
      headers: writer,
    });

    const audit = await app.inject({ method: "GET", url: "/api/v1/audit", headers: reader });
    const paths = audit.json().map((row: { toolOrPath: string }) => row.toolOrPath);
    expect(paths).toContain("/api/v1/panels");
    expect(paths).toContain("/api/v1/panels/:id");
    for (const row of audit
      .json()
      .filter((r: { toolOrPath: string }) => r.toolOrPath.startsWith("/api/v1/panels"))) {
      expect(row.keyId).toBe("k-annotate");
      expect(row.projectId).toBe("p1");
    }
  });

  it("never inserts an event", async () => {
    const store = makeStore();
    let inserted = 0;
    const app = await buildApp({
      store: {
        ...store,
        insertEvents: async (events) => {
          inserted += events.length;
        },
      },
      config,
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/panels",
      headers: writer,
      payload: spec(),
    });
    expect(inserted).toBe(0);
  });
});

describe("the OpenAPI document", () => {
  it("describes the panel paths under their own tag", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const doc = res.json();
    expect(doc.paths["/api/v1/panels"].get.operationId).toBe("list_panels");
    expect(doc.paths["/api/v1/panels"].post.operationId).toBe("pin_panel");
    expect(doc.paths["/api/v1/panels/{id}"].put.operationId).toBe("update_panel");
    expect(doc.paths["/api/v1/panels/{id}"].delete.operationId).toBe("unpin_panel");
    expect(doc.paths["/api/v1/panels"].post.tags).toEqual(["panels"]);
    expect(doc.tags.map((t: { name: string }) => t.name)).toContain("panels");
    expect(doc.components.schemas.PanelSpec).toBeTruthy();
  });
});
