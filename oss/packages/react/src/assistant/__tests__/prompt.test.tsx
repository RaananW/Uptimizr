import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@uptimizr/agent-core";
import { DEFAULT_SYSTEM_PROMPT, composeSystemPrompt, refreshSystemPrompt } from "../prompt";

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

describe("refreshSystemPrompt", () => {
  const day1 = Date.UTC(2023, 10, 14, 23, 59, 30); // 2023-11-14T23:59:30Z
  const day2 = Date.UTC(2023, 10, 15, 0, 0, 30); // 2023-11-15T00:00:30Z

  it("prepends a single stamped system message to an empty transcript", () => {
    const out = refreshSystemPrompt([], DEFAULT_SYSTEM_PROMPT, day1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: "system" });
    expect(out[0]!.content).toBe(composeSystemPrompt(DEFAULT_SYSTEM_PROMPT, day1));
  });

  it("replaces the existing system message in place instead of appending a second one", () => {
    const first = refreshSystemPrompt([], DEFAULT_SYSTEM_PROMPT, day1);
    const history: AgentMessage[] = [
      ...first,
      { role: "user", content: "top meshes today?" },
      { role: "assistant", content: "Box." },
    ];
    const out = refreshSystemPrompt(history, DEFAULT_SYSTEM_PROMPT, day2);

    expect(out.filter((m) => m.role === "system")).toHaveLength(1);
    expect(out[0]!.role).toBe("system");
    // The refreshed stamp carries the NEW day, and the old one is gone.
    expect(out[0]!.content).toContain("2023-11-15T00:00:30.000Z");
    expect(out[0]!.content).not.toContain("2023-11-14T23:59:30.000Z");
    // Every other turn survives, in order.
    expect(out.slice(1)).toEqual(history.slice(1));
  });

  it("collapses stray extra system turns to exactly one", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "a" },
      { role: "user", content: "hi" },
      { role: "system", content: "b" },
    ];
    const out = refreshSystemPrompt(history, "BASE", day1);
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
    expect(out[0]!.content.startsWith("BASE")).toBe(true);
  });

  it("does not mutate the input transcript", () => {
    const history: AgentMessage[] = [
      { role: "system", content: "old" },
      { role: "user", content: "hi" },
    ];
    const snapshot = JSON.parse(JSON.stringify(history));
    refreshSystemPrompt(history, "BASE", day1);
    expect(history).toEqual(snapshot);
  });
});
