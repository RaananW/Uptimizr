import { describe, expect, it } from "vitest";
import {
  AUDIT_PARAMS_MAX_LENGTH,
  apiKeyPrefix,
  clampAuditTool,
  generateApiKey,
  hasCapability,
  hashApiKey,
  parseApiKeyCapabilities,
  parseCapabilityList,
  serializeApiKeyCapabilities,
  serializeAuditParams,
  toApiKeyColumns,
  toApiKeyRateLimit,
} from "../metadata.js";

describe("api key helpers", () => {
  it("hashes deterministically and never returns plaintext", () => {
    const key = "utk_example";
    const hash = hashApiKey(key);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(key);
    expect(hashApiKey(key)).toBe(hash);
  });

  it("generates prefixed, unique keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.startsWith("utk_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("derives a stable display prefix", () => {
    const key = generateApiKey();
    expect(apiKeyPrefix(key)).toBe(key.slice(0, 12));
  });
});

describe("api key capability sets (#309)", () => {
  it("parses a stored set, deduplicated and canonically ordered", () => {
    expect(parseApiKeyCapabilities("query:raw,query,query")).toEqual(["query", "query:raw"]);
    expect(parseApiKeyCapabilities(" annotate , query ")).toEqual(["query", "annotate"]);
  });

  it("falls back to the legacy singular column, then to the default", () => {
    // A key issued before the capability set shipped.
    expect(parseApiKeyCapabilities(null, "ingest")).toEqual(["ingest"]);
    expect(parseApiKeyCapabilities("", "ingest")).toEqual(["ingest"]);
    // A populated set wins over the legacy column.
    expect(parseApiKeyCapabilities("query,annotate", "query")).toEqual(["query", "annotate"]);
    // Nothing stored at all → read-only.
    expect(parseApiKeyCapabilities(null, null)).toEqual(["query"]);
  });

  it("drops unknown tokens instead of throwing, so an older collector keeps working", () => {
    expect(parseApiKeyCapabilities("query,teleport")).toEqual(["query"]);
    // Every token unknown → the default, never an empty (powerless) set.
    expect(parseApiKeyCapabilities("teleport")).toEqual(["query"]);
  });

  it("serializes canonically and rejects an unknown token at the boundary", () => {
    expect(serializeApiKeyCapabilities(["query:raw", "query"])).toBe("query,query:raw");
    expect(serializeApiKeyCapabilities(undefined)).toBe("query");
    expect(() => serializeApiKeyCapabilities(["teleport" as never])).toThrowError(
      /Unknown API key capability/,
    );
  });

  it("parses a CLI --capabilities list", () => {
    expect(parseCapabilityList("query,annotate")).toEqual(["query", "annotate"]);
    expect(parseCapabilityList("")).toEqual(["query"]);
    expect(() => parseCapabilityList("query,write")).toThrowError(/Unknown API key capability/);
  });

  it("answers capability questions", () => {
    const key = { capabilities: ["query", "annotate"] as const };
    expect(hasCapability(key, "annotate")).toBe(true);
    expect(hasCapability(key, "query:raw")).toBe(false);
  });

  it("normalizes create options into column values", () => {
    expect(toApiKeyColumns()).toEqual({
      capabilities: "query",
      label: null,
      rateLimitMax: null,
      rateLimitWindowMs: null,
    });
    expect(
      toApiKeyColumns({
        capabilities: ["annotate", "query"],
        label: "  weekly-report-agent  ",
        rateLimit: { max: 60.7, windowMs: 60_000 },
      }),
    ).toEqual({
      capabilities: "query,annotate",
      label: "weekly-report-agent",
      rateLimitMax: 60,
      rateLimitWindowMs: 60_000,
    });
    expect(() => toApiKeyColumns({ rateLimit: { max: 0, windowMs: 1000 } })).toThrowError(
      /positive/,
    );
  });

  it("only honours a fully-configured per-key rate limit", () => {
    expect(toApiKeyRateLimit(60, 60_000)).toEqual({ max: 60, windowMs: 60_000 });
    expect(toApiKeyRateLimit(60, null)).toBeNull();
    expect(toApiKeyRateLimit(null, 60_000)).toBeNull();
    expect(toApiKeyRateLimit(0, 60_000)).toBeNull();
  });
});

describe("agent audit params (#309)", () => {
  it("never records a credential-shaped parameter", () => {
    const params = serializeAuditParams({
      scene: "lobby",
      apiKey: "utk_secret",
      api_key: "utk_secret",
      "x-api-key": "utk_secret",
      token: "live-token",
      secret: "s",
      password: "p",
      authorization: "Bearer x",
    });
    expect(params).not.toContain("utk_secret");
    expect(params).not.toContain("live-token");
    expect(JSON.parse(params)).toEqual({ scene: "lobby" });
  });

  it("bounds the serialized document and each value, staying valid JSON", () => {
    const params = serializeAuditParams(
      Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "x".repeat(300)])),
    );
    expect(params.length).toBeLessThanOrEqual(AUDIT_PARAMS_MAX_LENGTH);
    // Fields are dropped rather than the text cut, so a reader can always parse
    // a row; the marker says something was left out.
    const parsed = JSON.parse(params) as Record<string, unknown>;
    expect(parsed._truncated).toBe(true);
    // Each surviving value is itself clamped.
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "_truncated") continue;
      expect(String(value).length).toBeLessThanOrEqual(121);
    }
  });

  it("adds no truncation marker when everything fits", () => {
    expect(serializeAuditParams({ scene: "lobby", limit: 20 })).toBe(
      '{"scene":"lobby","limit":20}',
    );
  });

  it("summarizes nested values rather than embedding them", () => {
    expect(JSON.parse(serializeAuditParams({ region: [1, 2, 3], nested: { a: 1 } }))).toEqual({
      region: "[array]",
      nested: "[object]",
    });
  });

  it("tolerates a non-object, and drops nullish values", () => {
    expect(serializeAuditParams(undefined)).toBe("{}");
    expect(serializeAuditParams("nope")).toBe("{}");
    expect(serializeAuditParams({ a: null, b: undefined, c: 1 })).toBe('{"c":1}');
  });

  it("clamps an over-long endpoint path", () => {
    expect(clampAuditTool(`/api/v1/${"x".repeat(500)}`)).toHaveLength(200);
    expect(clampAuditTool("/api/v1/whoami")).toBe("/api/v1/whoami");
  });
});
