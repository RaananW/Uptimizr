import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";

// A pre-built static dashboard (`out/`) mirrored down to the two files the
// all-in-one serving path cares about: the SPA entry and the static project
// list emitted by the export.
let dashboardDir: string;

beforeAll(() => {
  dashboardDir = mkdtempSync(join(tmpdir(), "uptimizr-dash-"));
  writeFileSync(join(dashboardDir, "index.html"), "<!doctype html><title>dash</title>");
  mkdirSync(join(dashboardDir, "api"), { recursive: true });
  writeFileSync(join(dashboardDir, "api", "projects"), "[]");
});

afterAll(() => {
  rmSync(dashboardDir, { recursive: true, force: true });
});

function makeConfig(): CollectorConfig {
  return {
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
    dashboardDir,
  };
}

// buildApp does not touch the store at registration time; the static-serving
// tests never reach a query/collect handler, so a bare stub is enough.
const store = {} as unknown as CollectorStore;

describe("static dashboard serving", () => {
  it("serves index.html at the root", async () => {
    const app = await buildApp({ store, config: makeConfig() });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>dash</title>");
    await app.close();
  });

  it("serves the static project list emitted by the export", async () => {
    const app = await buildApp({ store, config: makeConfig() });
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("[]");
    await app.close();
  });

  it("falls back to index.html for SPA deep links", async () => {
    const app = await buildApp({ store, config: makeConfig() });
    const res = await app.inject({ method: "GET", url: "/projects/abc/session/xyz" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>dash</title>");
    await app.close();
  });

  it("keeps /health serving JSON, not the SPA", async () => {
    const app = await buildApp({ store, config: makeConfig() });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("404s unknown API paths as JSON rather than the SPA", async () => {
    const app = await buildApp({ store, config: makeConfig() });
    const res = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("stays headless when no dashboardDir is configured", async () => {
    const { dashboardDir: _omit, ...headless } = makeConfig();
    const app = await buildApp({ store, config: headless });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("sets a locked-down Content-Security-Policy for the bundled dashboard", async () => {
    const app = await buildApp({ store, config: makeConfig() });
    const res = await app.inject({ method: "GET", url: "/" });
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeTypeOf("string");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    // No blanket inline-script escape hatch.
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    await app.close();
  });

  it("omits the CSP when COLLECTOR_CSP is off", async () => {
    const app = await buildApp({ store, config: { ...makeConfig(), cspMode: "off" } });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.headers["content-security-policy"]).toBeUndefined();
    await app.close();
  });
});
