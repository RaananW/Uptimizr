import { describe, expect, it } from "vitest";
import type { Subscription } from "../api";
import { describeDelivery, describePredicate, formatAge, healthOf } from "../index";

/**
 * The Subscriptions panel's pure helpers (#311, ADR 0051 §6). The view itself is
 * a list; what is worth pinning down is how a subscription's state is reduced to
 * one badge and how each predicate kind reads in one line.
 */

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_1",
    projectId: "p1",
    name: "FPS drop in lobby",
    metric: "perf_summary",
    filters: { scene: "lobby" },
    evaluate: { every: "5m", window: "1h" },
    predicate: { kind: "threshold", column: "p50_fps", op: "<", value: 30 },
    cooldown: "1h",
    delivery: [{ kind: "sse" }],
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastFiredAt: null,
    lastError: null,
    failures: 0,
    ...overrides,
  };
}

describe("healthOf", () => {
  it("reports a disabled subscription as disabled, whatever else is true of it", () => {
    expect(healthOf(sub({ enabled: false, failures: 3, lastError: "boom" }))).toBe("disabled");
  });

  it("puts a delivery failure ahead of a successful firing", () => {
    expect(healthOf(sub({ lastFiredAt: "2026-01-02T00:00:00.000Z", failures: 2 }))).toBe("failing");
    expect(healthOf(sub({ lastError: "webhook responded 500" }))).toBe("failing");
  });

  it("distinguishes one that has fired from one that is only watching", () => {
    expect(healthOf(sub({ lastFiredAt: "2026-01-02T00:00:00.000Z" }))).toBe("fired");
    expect(healthOf(sub())).toBe("idle");
  });
});

describe("describePredicate", () => {
  it("renders every predicate kind in one line", () => {
    expect(describePredicate(sub())).toBe("perf_summary.p50_fps < 30");
    expect(describePredicate(sub({ predicate: { kind: "anomaly", sensitivity: 4 } }))).toBe(
      "perf_summary anomaly",
    );
    expect(describePredicate(sub({ predicate: { kind: "movers", pct: 25 } }))).toBe(
      "perf_summary moves by ±25%",
    );
    expect(describePredicate(sub({ predicate: { kind: "new_value", dimension: "scene" } }))).toBe(
      "new scene on perf_summary",
    );
    expect(describePredicate(sub({ predicate: { kind: "presence", op: "==", value: 0 } }))).toBe(
      "live sessions == 0",
    );
  });

  it("falls back to the metric for a kind it does not know", () => {
    expect(describePredicate(sub({ predicate: { kind: "from_the_future" } }))).toBe("perf_summary");
  });
});

describe("describeDelivery", () => {
  it("names the targets a firing goes to", () => {
    expect(describeDelivery(sub())).toBe("SSE");
    expect(
      describeDelivery(
        sub({ delivery: [{ kind: "sse" }, { kind: "webhook", url: "https://x.test/h" }] }),
      ),
    ).toBe("SSE + webhook");
  });
});

describe("formatAge", () => {
  const now = Date.parse("2026-01-10T12:00:00.000Z");

  it("reads a subscription that has never fired as `never`", () => {
    expect(formatAge(null, now)).toBe("never");
    expect(formatAge("not a date", now)).toBe("never");
  });

  it("coarsens to seconds, minutes, hours and days", () => {
    expect(formatAge("2026-01-10T11:59:40.000Z", now)).toBe("just now");
    expect(formatAge("2026-01-10T11:30:00.000Z", now)).toBe("30m ago");
    expect(formatAge("2026-01-10T06:00:00.000Z", now)).toBe("6h ago");
    expect(formatAge("2026-01-07T12:00:00.000Z", now)).toBe("3d ago");
  });
});
