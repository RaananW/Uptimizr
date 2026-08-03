import { describe, expect, it } from "vitest";
import type { TrackingQualityStat } from "../api";
import { trackingSummary, sessionDurationMs } from "../catalog/views/TrackingQuality";

/**
 * Pure-helper tests for the tracking-quality view (#155, ADR 0048): the
 * degraded-time roll-up (hand vs. controller split), the degraded share of
 * session time, and the session-span parsing.
 */

function stat(overrides: Partial<TrackingQualityStat>): TrackingQualityStat {
  return {
    session_id: "s",
    degraded_ms: 0,
    hand_degraded_ms: 0,
    controller_degraded_ms: 0,
    degraded_episodes: 0,
    started_at: "2024-06-16 10:00:00.000",
    ended_at: "2024-06-16 10:00:00.000",
    ...overrides,
  };
}

describe("sessionDurationMs", () => {
  it("parses the engine-formatted span", () => {
    expect(
      sessionDurationMs(
        stat({ started_at: "2024-06-16 10:00:00.000", ended_at: "2024-06-16 10:00:20.000" }),
      ),
    ).toBe(20_000);
  });

  it("returns 0 for an unparseable timestamp", () => {
    expect(sessionDurationMs(stat({ started_at: "nope", ended_at: "nope" }))).toBe(0);
  });
});

describe("trackingSummary", () => {
  it("sums degraded time and derives the degraded share of session span", () => {
    const summary = trackingSummary([
      stat({
        started_at: "2024-06-16 10:00:00.000",
        ended_at: "2024-06-16 10:01:00.000", // 60s span
        degraded_ms: 6_000,
        hand_degraded_ms: 6_000,
        degraded_episodes: 2,
      }),
      stat({
        started_at: "2024-06-16 10:00:00.000",
        ended_at: "2024-06-16 10:01:00.000", // 60s span
        degraded_ms: 12_000,
        controller_degraded_ms: 12_000,
        degraded_episodes: 1,
      }),
    ]);
    expect(summary.sessions).toBe(2);
    expect(summary.spanMs).toBe(120_000);
    expect(summary.degradedMs).toBe(18_000);
    expect(summary.handMs).toBe(6_000);
    expect(summary.controllerMs).toBe(12_000);
    expect(summary.episodes).toBe(3);
    expect(summary.degradedShare).toBeCloseTo(0.15, 5); // 18000 / 120000
  });

  it("clamps the degraded share to at most 1", () => {
    const summary = trackingSummary([
      stat({
        started_at: "2024-06-16 10:00:00.000",
        ended_at: "2024-06-16 10:00:01.000", // 1s span
        degraded_ms: 5_000, // coarse best-effort overrun
        hand_degraded_ms: 5_000,
        degraded_episodes: 1,
      }),
    ]);
    expect(summary.degradedShare).toBe(1);
  });

  it("returns an all-zero summary for no sessions", () => {
    const summary = trackingSummary([]);
    expect(summary).toEqual({
      sessions: 0,
      spanMs: 0,
      degradedMs: 0,
      handMs: 0,
      controllerMs: 0,
      episodes: 0,
      degradedShare: 0,
    });
  });
});
