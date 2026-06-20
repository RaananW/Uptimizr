import { describe, expect, it } from "vitest";
import { apiKeyPrefix, generateApiKey, hashApiKey } from "../metadata.js";

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
