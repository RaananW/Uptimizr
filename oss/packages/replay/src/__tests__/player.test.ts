import { describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { ReplayPlayer } from "../player.js";
import type { PlayerEnv, ReplayDriver } from "../types.js";

function camera(ts: number, x: number): AnyEvent {
  return {
    type: "camera_sample",
    projectId: "p",
    sessionId: "s",
    ts,
    sdkVersion: "0.1.0",
    position: [x, 0, 0],
    direction: [0, 0, 1],
  } as AnyEvent;
}

function recorder(): ReplayDriver & { applied: AnyEvent[]; resets: number } {
  const applied: AnyEvent[] = [];
  return {
    applied,
    resets: 0,
    reset() {
      this.resets++;
      applied.length = 0;
    },
    apply(event) {
      applied.push(event);
    },
  };
}

const base = 1_000_000;
const events = [camera(base, 0), camera(base + 100, 1), camera(base + 300, 2)];

describe("ReplayPlayer.update", () => {
  it("computes duration relative to the first event", () => {
    const player = new ReplayPlayer(events, recorder());
    expect(player.durationMs).toBe(300);
  });

  it("applies events up to the elapsed time", () => {
    const driver = recorder();
    const player = new ReplayPlayer(events, driver);
    player.update(100);
    expect(driver.applied).toHaveLength(2);
    player.update(300);
    expect(driver.applied).toHaveLength(3);
  });

  it("resets and replays from start on backward seek", () => {
    const driver = recorder();
    const player = new ReplayPlayer(events, driver);
    player.update(300);
    expect(driver.applied).toHaveLength(3);
    player.seek(100);
    expect(driver.resets).toBe(1);
    expect(driver.applied).toHaveLength(2);
  });

  it("fires onComplete once at the end", () => {
    let completed = 0;
    const player = new ReplayPlayer(events, recorder(), { onComplete: () => completed++ });
    player.update(300);
    player.update(300);
    expect(completed).toBe(1);
  });
});

describe("ReplayPlayer.play", () => {
  it("ticks the driver from the animation loop", () => {
    let clock = 0;
    const frames: Array<() => void> = [];
    const env: PlayerEnv = {
      now: () => clock,
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => {},
    };
    const driver = recorder();
    const player = new ReplayPlayer(events, driver, {}, env);

    player.play();
    // first frame at t=0 applies the first event
    frames.pop()!();
    expect(driver.applied).toHaveLength(1);

    clock = 150;
    frames.pop()!();
    expect(driver.applied).toHaveLength(2);

    clock = 400;
    frames.pop()!();
    expect(driver.applied).toHaveLength(3);
    expect(player.isPlaying).toBe(false); // auto-paused at end
  });
});
