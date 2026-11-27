import { describe, expect, it } from "vitest";
import { liveEventKey } from "../liveEventKey";
import {
  countSeparatePulses,
  createLiveFrontier,
  createLiveRayScheduler,
  type LiveEventLike,
} from "../liveIngest";

/**
 * The live replay's bookkeeping, run over whole event streams shaped like the
 * ones a connector sends: a click is four events in one millisecond (press,
 * release, click, pick), camera samples stream between them, events arrive in
 * SDK batches seconds after they happened, and the stream's connect-time
 * backfill repeats the tail the replay already loaded.
 */

/** The four events one click on `mesh` emits, all with the same `ts`. */
function click(ts: number, mesh = "wall-s"): LiveEventLike[] {
  return [
    { type: "pointer_down", ts, hitMesh: mesh },
    { type: "pointer_up", ts, hitMesh: mesh },
    { type: "pointer_click", ts, hitMesh: mesh, hitPoint: [0, 1, 2] },
    { type: "mesh_interaction", ts, mesh, point: [0, 1, 2] },
  ];
}

/** Camera samples every `step` ms over `[from, to)`. */
function cameras(from: number, to: number, step = 100): LiveEventLike[] {
  const out: LiveEventLike[] = [];
  for (let ts = from; ts < to; ts += step) {
    out.push({ type: "camera_sample", ts, position: [0, 1.8, 0], direction: [0, 0, 1] });
  }
  return out;
}

const byTs = (a: LiveEventLike, b: LiveEventLike): number => (a.ts as number) - (b.ts as number);

/**
 * Feed `batches` through a frontier and scheduler the way the replay does. Each
 * batch arrives with the playhead at `arriveAt` (session-relative ms).
 */
function replay(
  loaded: LiveEventLike[],
  batches: { arriveAt: number; events: LiveEventLike[] }[],
  baseTs = 0,
) {
  const frontier = createLiveFrontier(loaded);
  let playhead = 0;
  const scheduler = createLiveRayScheduler(() => playhead);
  const accepted: LiveEventLike[] = [];
  const clicks: { at: number; shownAt: number }[] = [];
  const picks: { at: number; shownAt: number }[] = [];
  for (const batch of batches) {
    playhead = batch.arriveAt;
    for (const ev of batch.events) {
      if (!frontier.accept(ev)) continue;
      accepted.push(ev);
      const at = (ev.ts as number) - baseTs;
      if (ev.type === "pointer_click") clicks.push({ at, shownAt: scheduler.click(at) });
      if (ev.type === "mesh_interaction") picks.push({ at, shownAt: scheduler.pick(at) });
    }
  }
  return { accepted, clicks, picks };
}

describe("createLiveFrontier", () => {
  it("accepts every event of a click, though they share one millisecond", () => {
    const frontier = createLiveFrontier([]);
    expect(click(1_000).map((e) => frontier.accept(e))).toEqual([true, true, true, true]);
  });

  it("rejects the backfill's repeat of what the replay already loaded", () => {
    const loaded = [...cameras(0, 1_100), ...click(1_000)].sort(byTs);
    const frontier = createLiveFrontier(loaded);
    // The backfill repeats the loaded tail, the click included, then goes on.
    const backfill = [...cameras(500, 2_000), ...click(1_000), ...click(1_500)].sort(byTs);
    const accepted = backfill.filter((e) => frontier.accept(e));
    expect(accepted.filter((e) => e.type === "pointer_click").map((e) => e.ts)).toEqual([1_500]);
    expect(accepted.every((e) => (e.ts as number) > 1_000)).toBe(true);
  });

  it("still accepts a new event in the loaded tail's last millisecond", () => {
    // The replay loaded the click's press and release; the click itself was
    // still in flight and arrives on the stream.
    const quad = click(1_000);
    const frontier = createLiveFrontier(quad.slice(0, 2));
    expect(quad.map((e) => frontier.accept(e))).toEqual([false, false, true, true]);
  });

  it("rejects an event without a usable timestamp", () => {
    const frontier = createLiveFrontier([]);
    expect(frontier.accept({ type: "pointer_click" })).toBe(false);
    expect(frontier.accept({ type: "pointer_click", ts: Number.NaN })).toBe(false);
    expect(frontier.accept({ type: "pointer_click", ts: "1000" })).toBe(false);
  });
});

describe("createLiveRayScheduler", () => {
  it("plays a click that arrives late from the moment it arrives", () => {
    let now = 4_000;
    const scheduler = createLiveRayScheduler(() => now);
    expect(scheduler.click(1_000)).toBe(4_000);
    // A click from the future of the playhead plays at its own time.
    now = 4_100;
    expect(createLiveRayScheduler(() => now).click(5_000)).toBe(5_000);
  });

  it("does not let the schedule fall behind the live edge after a pause", () => {
    let now = 4_000;
    const scheduler = createLiveRayScheduler(() => now);
    scheduler.click(1_000);
    now = 20_000; // the next batch arrives much later
    expect(scheduler.click(16_000)).toBe(20_000);
  });

  it("plays a click that is older than the previous one at the playhead", () => {
    let now = 4_000;
    const scheduler = createLiveRayScheduler(() => now);
    scheduler.click(2_000);
    now = 4_200;
    expect(scheduler.click(1_500)).toBe(4_200);
  });
});

describe("a live session, end to end", () => {
  it("draws every click of a batch, each in turn at its real spacing", () => {
    // Three locked clicks 900 ms apart, all sent in one SDK batch that reaches
    // the dashboard 3 s after the first one.
    const events = [
      ...cameras(10_000, 13_500),
      ...click(11_000),
      ...click(11_900),
      ...click(12_800),
    ].sort(byTs);
    const { clicks, picks } = replay(cameras(0, 10_000), [{ arriveAt: 14_000, events }]);

    expect(clicks.map((c) => c.at)).toEqual([11_000, 11_900, 12_800]);
    expect(clicks.map((c) => c.shownAt)).toEqual([14_000, 14_900, 15_800]);
    // Each pick plays with its own click, not as an extra pulse.
    expect(picks.map((p) => p.shownAt)).toEqual([14_000, 14_900, 15_800]);
  });

  it("keeps every click across batches, the backfill overlap and same-ms neighbours", () => {
    // Loaded history ends with a click at 10 000; the stream starts with a
    // backfill from 9 000, then two batches 3 s apart.
    const loaded = [...cameras(0, 10_100), ...click(10_000)].sort(byTs);
    const backfill = [...cameras(9_000, 10_100), ...click(10_000)].sort(byTs);
    const batch1 = [...cameras(10_100, 13_000), ...click(11_000), ...click(11_000, "door")].sort(
      byTs,
    );
    const batch2 = [...cameras(13_000, 16_000), ...click(14_500)].sort(byTs);
    const { accepted, clicks } = replay(loaded, [
      { arriveAt: 10_100, events: backfill },
      { arriveAt: 13_200, events: batch1 },
      { arriveAt: 16_200, events: batch2 },
    ]);

    // The loaded click is not drawn twice; the two clicks in the same
    // millisecond on different meshes are both kept.
    expect(clicks.map((c) => c.at)).toEqual([11_000, 11_000, 14_500]);
    // No event is accepted twice, and every new camera sample is.
    expect(new Set(accepted.map(liveEventKey)).size).toBe(accepted.length);
    expect(accepted.filter((e) => e.type === "camera_sample")).toHaveLength(29 + 30);
    // Nothing older than the loaded history is accepted.
    expect(accepted.every((e) => (e.ts as number) > 10_000)).toBe(true);
  });
});

describe("countSeparatePulses", () => {
  it("counts rays that start together as one pulse", () => {
    // Three clicks drawn in the same few frames, as when a batch played at once.
    expect(countSeparatePulses([14_000, 14_016, 14_033], 450)).toBe(1);
  });

  it("counts rays at their real spacing as separate pulses", () => {
    expect(countSeparatePulses([15_800, 14_000, 14_900], 450)).toBe(3);
    expect(countSeparatePulses([], 450)).toBe(0);
  });
});
