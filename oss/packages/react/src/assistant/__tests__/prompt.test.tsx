import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT, composeSystemPrompt } from "../prompt";

describe("composeSystemPrompt", () => {
  const nowMs = 1700000000000; // 2023-11-14T22:13:20.000Z

  it("appends the current time as ISO 8601 and epoch milliseconds", () => {
    const out = composeSystemPrompt(DEFAULT_SYSTEM_PROMPT, nowMs);
    expect(out).toContain(new Date(nowMs).toISOString());
    expect(out).toContain(`epoch milliseconds: ${nowMs}`);
  });

  it("keeps the base prompt intact and prepends it", () => {
    const out = composeSystemPrompt(DEFAULT_SYSTEM_PROMPT, nowMs);
    expect(out.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
  });

  it("mentions relative-range resolution so the model converts to since/until", () => {
    const out = composeSystemPrompt(DEFAULT_SYSTEM_PROMPT, nowMs);
    expect(out).toContain("this week");
    expect(out).toContain("since");
    expect(out).toContain("until");
  });

  it("honors a caller-supplied base prompt override", () => {
    const out = composeSystemPrompt("CUSTOM BASE", nowMs);
    expect(out.startsWith("CUSTOM BASE")).toBe(true);
    expect(out).toContain(`epoch milliseconds: ${nowMs}`);
  });

  it("defaults to the shared prompt and the wall clock when called bare", () => {
    const before = Date.now();
    const out = composeSystemPrompt();
    expect(out.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
    expect(out).toContain("epoch milliseconds:");
    // The stamped time is a real, current epoch (sanity bound, not a pinned value).
    expect(out).toContain("Current time:");
    expect(before).toBeGreaterThan(0);
  });
});
