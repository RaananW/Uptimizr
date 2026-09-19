import { describe, expect, it } from "vitest";
import { getMetric, type MetricDefinition } from "@uptimizr/metrics";
import type { MetricBucketOptions, MetricBucketRow, SubscriptionRecord } from "@uptimizr/db";
import type { SubscriptionPredicate } from "@uptimizr/schema";
import {
  bucketFor,
  compare,
  evaluateSubscription,
  resolveWindow,
  summaryFor,
  thresholdColumnFor,
  toFiring,
} from "../subscriptions/evaluate.js";

/**
 * Predicate evaluation (#311, sketch §F.2).
 *
 * Every case drives the real evaluator with a fake {@link readBuckets}, so the
 * whole predicate vocabulary is exercised without a store, a timer or a server —
 * which is the point of keeping the evaluator a pure function of rows.
 */

const HOUR = 3_600_000;
/** A round hour, so a `resolveWindow` floor is easy to reason about in tests. */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const PERF: MetricDefinition = getMetric("perf_summary") as MetricDefinition;
const EVENTS: MetricDefinition = getMetric("event_counts") as MetricDefinition;

function subscription(
  predicate: SubscriptionPredicate,
  overrides: Partial<SubscriptionRecord> = {},
): SubscriptionRecord {
  return {
    id: "sub_test",
    projectId: "p1",
    name: "test",
    metric: "perf_summary",
    filters: { scene: "lobby" },
    evaluate: { every: "5m", window: "2h", bucket: "hour" },
    predicate,
    cooldown: "1h",
    delivery: [{ kind: "sse" }],
    enabled: true,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    lastFiredAt: null,
    lastError: null,
    failures: 0,
    ...overrides,
  };
}

/** A reader that answers with fixed rows and records what it was asked. */
function reader(rows: MetricBucketRow[]): {
  read: (opts: MetricBucketOptions) => Promise<MetricBucketRow[]>;
  calls: MetricBucketOptions[];
} {
  const calls: MetricBucketOptions[] = [];
  return {
    read: async (opts) => {
      calls.push(opts);
      return rows;
    },
    calls,
  };
}

function bucket(offsetHours: number, value: number | null, sample = 100): MetricBucketRow {
  return { bucket: NOW + offsetHours * HOUR, value, sample_size: sample };
}

describe("compare", () => {
  it("implements every declared operator", () => {
    expect(compare(1, "<", 2)).toBe(true);
    expect(compare(2, "<", 2)).toBe(false);
    expect(compare(2, "<=", 2)).toBe(true);
    expect(compare(3, ">", 2)).toBe(true);
    expect(compare(2, ">=", 2)).toBe(true);
    expect(compare(2, "==", 2)).toBe(true);
    expect(compare(2, "!=", 2)).toBe(false);
  });
});

describe("resolveWindow", () => {
  it("floors `since` to the bucket but ends at the instant of evaluation", () => {
    const at = NOW + 17 * 60_000;
    const window = resolveWindow(2 * HOUR, "hour", at);
    expect(window.since).toBe(NOW - 2 * HOUR);
    // Deliberately *not* floored: a subscription asks about right now, so the
    // partial current bucket is in scope.
    expect(window.until).toBe(at);
  });

  it("never resolves to less than one bucket", () => {
    const window = resolveWindow(60_000, "hour", NOW);
    expect(window.until - window.since).toBe(HOUR);
  });
});

describe("bucketFor", () => {
  it("honours a declared grain, else picks one from the window length", () => {
    expect(bucketFor(subscription({ kind: "anomaly" }))).toBe("hour");
    expect(
      bucketFor(subscription({ kind: "anomaly" }, { evaluate: { every: "1h", window: "6h" } })),
    ).toBe("hour");
    expect(
      bucketFor(subscription({ kind: "anomaly" }, { evaluate: { every: "1h", window: "30d" } })),
    ).toBe("day");
    expect(
      bucketFor(
        subscription(
          { kind: "anomaly" },
          { evaluate: { every: "1h", window: "2h", bucket: "day" } },
        ),
      ),
    ).toBe("day");
  });
});

describe("thresholdColumnFor", () => {
  it("is the registry's comparable primary", () => {
    expect(thresholdColumnFor(PERF)).toBe("p50_fps");
  });
});

describe("threshold predicate", () => {
  const predicate: SubscriptionPredicate = {
    kind: "threshold",
    column: "p50_fps",
    op: "<",
    value: 40,
  };

  it("fires when the window's rolled-up value crosses the level", async () => {
    const { read, calls } = reader([bucket(-2, 55), bucket(-1, 20)]);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription(predicate),
      PERF,
    );

    expect(result.fired).toBe(true);
    // `perf_summary`'s bucket rollup is a mean, so 55 and 20 average to 37.5.
    expect(result.value).toBe(37.5);
    expect(result.expected).toBe(40);
    expect(result.sampleSize).toBe(200);
    expect(result.reason).toContain("perf_summary.p50_fps is 37.5");
    // One read, scoped to the subscription's scene and metric.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ metric: "perf_summary", scene: "lobby", bucket: "hour" });
  });

  it("does not fire when the value is on the right side of the level", async () => {
    const { read } = reader([bucket(-1, 60)]);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription(predicate),
      PERF,
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toContain("which is not < 40");
  });

  it("is gated by minSample — an explicit one wins over the registry's", async () => {
    // `perf_summary` declares minSample 30; five samples is below it.
    const thin = reader([bucket(-1, 5, 5)]);
    const registryGated = await evaluateSubscription(
      { readBuckets: thin.read, now: () => NOW },
      subscription(predicate),
      PERF,
    );
    expect(registryGated.fired).toBe(false);
    expect(registryGated.reason).toContain("below minSample 30");

    const explicit = reader([bucket(-1, 5, 5)]);
    const lowered = await evaluateSubscription(
      { readBuckets: explicit.read, now: () => NOW },
      subscription({ ...predicate, minSample: 1 }),
      PERF,
    );
    expect(lowered.fired).toBe(true);
  });

  it("does not fire when the window has samples but no value", async () => {
    const { read } = reader([bucket(-1, null, 500)]);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription(predicate),
      PERF,
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toContain("no value");
  });
});

describe("movers predicate", () => {
  it("compares the window against the equal one before it, in one read", async () => {
    // Reference window [-4h,-2h) averages 100; current [-2h,now) averages 50.
    const { read, calls } = reader([
      bucket(-4, 100),
      bucket(-3, 100),
      bucket(-2, 50),
      bucket(-1, 50),
    ]);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription({ kind: "movers", pct: 25 }, { metric: "event_counts" }),
      EVENTS,
    );

    expect(result.fired).toBe(true);
    expect(result.reason).toContain("-50%");
    // One scan spanning both windows, not two.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.since).toBe(NOW - 4 * HOUR);
  });

  it("respects a direction filter", async () => {
    const rows = [bucket(-4, 100), bucket(-3, 100), bucket(-2, 50), bucket(-1, 50)];
    const up = await evaluateSubscription(
      { readBuckets: reader(rows).read, now: () => NOW },
      subscription({ kind: "movers", pct: 25, direction: "up" }, { metric: "event_counts" }),
      EVENTS,
    );
    expect(up.fired).toBe(false);

    const down = await evaluateSubscription(
      { readBuckets: reader(rows).read, now: () => NOW },
      subscription({ kind: "movers", pct: 25, direction: "down" }, { metric: "event_counts" }),
      EVENTS,
    );
    expect(down.fired).toBe(true);
  });

  it("stays quiet inside the threshold", async () => {
    const { read } = reader([bucket(-4, 100), bucket(-3, 100), bucket(-2, 95), bucket(-1, 95)]);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription({ kind: "movers", pct: 25 }, { metric: "event_counts" }),
      EVENTS,
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toContain("inside the ±25% threshold");
  });
});

describe("anomaly predicate", () => {
  /** A flat history of `hours` buckets ending just before the window. */
  function flatHistory(hours: number, value: number): MetricBucketRow[] {
    return Array.from({ length: hours }, (_, i) => bucket(-(hours + 1) + i, value));
  }

  it("fires on a spike inside the evaluation window", async () => {
    const rows = [...flatHistory(24, 60), bucket(-1, 5)];
    const { read, calls } = reader(rows);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription({ kind: "anomaly", sensitivity: 3 }),
      PERF,
    );

    expect(result.fired).toBe(true);
    expect(result.value).toBe(5);
    expect(result.reason).toContain("perf_summary was");
    // The read reaches back over the primitive's trailing window, not just the
    // evaluation window — a bucket cannot be judged without history.
    expect(calls[0]?.since).toBeLessThan(NOW - 2 * HOUR);
  });

  it("ignores an anomaly that falls outside the evaluation window", async () => {
    // The spike is 10 hours back; the window is the last 2.
    const rows = [...flatHistory(24, 60), bucket(-1, 60)];
    rows[14] = bucket(-10, 5);
    const { read } = reader(rows);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription({ kind: "anomaly", sensitivity: 3 }),
      PERF,
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toContain("no anomalous hour bucket");
  });

  it("says so rather than guessing when there is too little history", async () => {
    const { read } = reader([bucket(-2, 60), bucket(-1, 5)]);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription({ kind: "anomaly" }),
      PERF,
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toContain("history");
  });
});

describe("new_value predicate", () => {
  function split(offsetHours: number, value: string, dimension: string): MetricBucketRow {
    return {
      bucket: NOW + offsetHours * HOUR,
      value: 1,
      sample_size: 10,
      dimension_value: dimension,
      ...(value ? {} : {}),
    };
  }

  it("fires on a dimension value absent from the reference window", async () => {
    const { read, calls } = reader([
      split(-4, "", "lobby"),
      split(-3, "", "lobby"),
      split(-1, "", "lobby"),
      split(-1, "", "showroom"),
    ]);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription({ kind: "new_value", dimension: "scene" }, { metric: "event_counts" }),
      EVENTS,
    );

    expect(result.fired).toBe(true);
    expect(result.dimensionValue).toBe("showroom");
    expect(result.reason).toContain('new scene "showroom"');
    expect(calls[0]?.groupBy).toBe("scene");
  });

  it("stays quiet when every value was already seen (first-seen semantics)", async () => {
    const { read } = reader([
      split(-4, "", "lobby"),
      split(-3, "", "showroom"),
      split(-1, "", "lobby"),
      split(-1, "", "showroom"),
    ]);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription({ kind: "new_value", dimension: "scene" }, { metric: "event_counts" }),
      EVENTS,
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toContain("no unseen scene value");
  });

  it("never fires on the store's unattributed empty value", async () => {
    const { read } = reader([split(-4, "", "lobby"), split(-1, "", "")]);
    const result = await evaluateSubscription(
      { readBuckets: read, now: () => NOW },
      subscription({ kind: "new_value", dimension: "scene" }, { metric: "event_counts" }),
      EVENTS,
    );
    expect(result.fired).toBe(false);
  });
});

describe("presence predicate", () => {
  it("reads the live bus and issues no store query at all", async () => {
    const { read, calls } = reader([]);
    const result = await evaluateSubscription(
      { readBuckets: read, activeSessions: () => 0, now: () => NOW },
      subscription({ kind: "presence", op: "==", value: 0 }),
      PERF,
    );

    expect(result.fired).toBe(true);
    expect(result.value).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("does not fire while the level holds", async () => {
    const { read } = reader([]);
    const result = await evaluateSubscription(
      { readBuckets: read, activeSessions: () => 12, now: () => NOW },
      subscription({ kind: "presence", op: ">", value: 50 }),
      PERF,
    );
    expect(result.fired).toBe(false);
  });
});

describe("toFiring / summaryFor", () => {
  it("shapes a firing record and a bounded registry summary", async () => {
    const { read } = reader([bucket(-2, 55), bucket(-1, 20)]);
    const sub = subscription({ kind: "threshold", column: "p50_fps", op: "<", value: 40 });
    const result = await evaluateSubscription({ readBuckets: read, now: () => NOW }, sub, PERF);

    const firing = toFiring(sub, result, NOW);
    expect(firing).toMatchObject({
      subscriptionId: "sub_test",
      metric: "perf_summary",
      predicate: "threshold",
      at: NOW,
      scene: "lobby",
      value: 37.5,
      expected: 40,
    });

    const summary = summaryFor(sub, result);
    expect(summary).not.toBeNull();
    // A real `format=summary` envelope of a real registry metric, so anything
    // that renders one already renders this.
    expect(summary).toHaveProperty("metric", "insight_baseline");
  });

  it("has no summary for a predicate that read no series", async () => {
    const { read } = reader([]);
    const sub = subscription({ kind: "presence", op: "==", value: 0 });
    const result = await evaluateSubscription(
      { readBuckets: read, activeSessions: () => 0, now: () => NOW },
      sub,
      PERF,
    );
    expect(summaryFor(sub, result)).toBeNull();
  });
});
