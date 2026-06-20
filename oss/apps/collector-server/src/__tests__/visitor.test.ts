import { describe, expect, it } from "vitest";
import { dailySalt, visitorHash } from "../visitor.js";

describe("visitor hashing", () => {
  it("derives a different salt per day", () => {
    const a = dailySalt("secret", new Date("2024-06-16T23:00:00Z"));
    const b = dailySalt("secret", new Date("2024-06-17T01:00:00Z"));
    expect(a).not.toBe(b);
  });

  it("is deterministic within a day", () => {
    const date = new Date("2024-06-16T10:00:00Z");
    expect(dailySalt("secret", date)).toBe(dailySalt("secret", date));
  });

  it("produces a stable 32-char visitor id and changes with the salt", () => {
    const id1 = visitorHash("1.2.3.4", "UA", "salt-a");
    const id2 = visitorHash("1.2.3.4", "UA", "salt-b");
    expect(id1).toHaveLength(32);
    expect(id1).not.toBe(id2);
    expect(visitorHash("1.2.3.4", "UA", "salt-a")).toBe(id1);
  });

  it("does not contain the raw ip", () => {
    const id = visitorHash("203.0.113.7", "UA", "salt");
    expect(id).not.toContain("203.0.113.7");
  });
});
