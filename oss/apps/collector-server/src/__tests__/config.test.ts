import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const baseEnv = { VISITOR_HASH_SECRET: "test-secret" };

describe("loadConfig — COLLECTOR_TRUST_PROXY", () => {
  it("defaults to not trusting proxy headers", () => {
    expect(loadConfig({ ...baseEnv }).trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv, COLLECTOR_TRUST_PROXY: "" }).trustProxy).toBe(false);
  });

  it("parses booleans case-insensitively", () => {
    expect(loadConfig({ ...baseEnv, COLLECTOR_TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ...baseEnv, COLLECTOR_TRUST_PROXY: "TRUE" }).trustProxy).toBe(true);
    expect(loadConfig({ ...baseEnv, COLLECTOR_TRUST_PROXY: "false" }).trustProxy).toBe(false);
  });

  it("passes an IP, CIDR, or comma-separated list through to Fastify", () => {
    expect(loadConfig({ ...baseEnv, COLLECTOR_TRUST_PROXY: "10.0.0.1" }).trustProxy).toBe(
      "10.0.0.1",
    );
    expect(loadConfig({ ...baseEnv, COLLECTOR_TRUST_PROXY: " 10.0.0.0/8 " }).trustProxy).toBe(
      "10.0.0.0/8",
    );
    expect(
      loadConfig({ ...baseEnv, COLLECTOR_TRUST_PROXY: "10.0.0.1,192.168.0.0/16" }).trustProxy,
    ).toBe("10.0.0.1,192.168.0.0/16");
  });

  // Fastify 5.12.1 fails closed on a numeric trustProxy (it cannot validate the
  // immediate peer), which would silently bucket the visitor hash and rate limit
  // on the proxy's IP. Fail at startup instead of degrading in production.
  it("rejects a bare hop count rather than silently ignoring proxy headers", () => {
    expect(() => loadConfig({ ...baseEnv, COLLECTOR_TRUST_PROXY: "1" })).toThrow(
      /no longer accepts a hop count/,
    );
    expect(() => loadConfig({ ...baseEnv, COLLECTOR_TRUST_PROXY: "0" })).toThrow(
      /no longer accepts a hop count/,
    );
  });
});
