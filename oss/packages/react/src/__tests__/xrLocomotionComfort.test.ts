import { describe, expect, it } from "vitest";
import type { XrLocomotionStat } from "../api";
import {
  locomotionMix,
  comfortCorrelation,
  sessionDurationMs,
} from "../catalog/views/XrLocomotionComfort";

/**
 * Pure-helper tests for the VR comfort & locomotion view (#148): the
 * locomotion-style mix (teleport vs. smooth fly vs. navigate), the session-span
 * parsing, and the heavy-vs-light early-exit correlation.
 */

function stat(overrides: Partial<XrLocomotionStat>): XrLocomotionStat {
  return {
    session_id: "s",
    fly_gestures: 0,
    navigate_gestures: 0,
    teleports: 0,
    locomotion_ms: 0,
    started_at: "2024-06-16 10:00:00.000",
    ended_at: "2024-06-16 10:00:00.000",
    ...overrides,
  };
}

describe("locomotionMix", () => {
  it("derives smooth locomotion as fly minus teleports, floored at zero", () => {
    const mix = locomotionMix([
      stat({ fly_gestures: 10, teleports: 3, navigate_gestures: 2 }),
      stat({ fly_gestures: 1, teleports: 4, navigate_gestures: 0 }), // more picks than flies
    ]);
    expect(mix.teleport).toBe(7);
    expect(mix.smooth).toBe(7); // (10-3) + max(0, 1-4)
    expect(mix.navigate).toBe(2);
    expect(mix.total).toBe(16);
  });

  it("returns an all-zero mix for no sessions", () => {
    expect(locomotionMix([])).toEqual({ teleport: 0, smooth: 0, navigate: 0, total: 0 });
  });
});

describe("sessionDurationMs", () => {
  it("parses the DuckDB space-separated timestamp format", () => {
    expect(
      sessionDurationMs(
        stat({ started_at: "2024-06-16 10:00:00.000", ended_at: "2024-06-16 10:00:20.000" }),
      ),
    ).toBe(20_000);
  });

  it("returns 0 for unparseable timestamps", () => {
    expect(sessionDurationMs(stat({ started_at: "nope", ended_at: "also-nope" }))).toBe(0);
  });
});

describe("comfortCorrelation", () => {
  it("returns null when there are fewer than two sessions", () => {
    expect(comfortCorrelation([])).toBeNull();
    expect(comfortCorrelation([stat({ fly_gestures: 5 })])).toBeNull();
  });

  it("splits by median locomotion rate and surfaces a higher early-exit rate for heavy sessions", () => {
    const heavyA = stat({
      session_id: "hA",
      fly_gestures: 20,
      started_at: "2024-06-16 10:00:00.000",
      ended_at: "2024-06-16 10:00:20.000", // 20s span → early exit
    });
    const heavyB = stat({
      session_id: "hB",
      fly_gestures: 30,
      started_at: "2024-06-16 10:00:00.000",
      ended_at: "2024-06-16 10:00:25.000", // 25s span → early exit
    });
    const lightC = stat({
      session_id: "lC",
      fly_gestures: 2,
      started_at: "2024-06-16 10:00:00.000",
      ended_at: "2024-06-16 10:02:00.000", // 120s span
    });
    const lightD = stat({
      session_id: "lD",
      fly_gestures: 1,
      started_at: "2024-06-16 10:00:00.000",
      ended_at: "2024-06-16 10:05:00.000", // 300s span
    });

    const corr = comfortCorrelation([lightC, heavyA, lightD, heavyB]);
    expect(corr).not.toBeNull();
    expect(corr!.heavy.sessions).toBe(2);
    expect(corr!.light.sessions).toBe(2);
    expect(corr!.heavy.earlyExitRate).toBe(1); // both heavy sessions exited early
    expect(corr!.light.earlyExitRate).toBe(0);
    expect(corr!.heavy.avgDurationMs).toBeLessThan(corr!.light.avgDurationMs);
  });
});
