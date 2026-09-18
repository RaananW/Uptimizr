/**
 * `buildSessionNarrative` — the pure compaction behind the session narrative
 * (#314, ADR 0051 §7, design sketch §G.2).
 *
 * Everything here runs against one **synthetic session** built to exercise each
 * entry kind at a known timestamp, so the assertions are about ordering, folding
 * and bounds rather than about whatever a real capture happened to contain. Every
 * event in the fixture deliberately carries a visitor hash, a URL and page
 * metadata: the last block asserts that none of it survives the compaction,
 * which is the ADR 0003 guarantee the route's two gates rest on.
 */

import { describe, expect, it } from "vitest";
import { NARRATIVE_LIMITS } from "@uptimizr/metrics";
import type { AnyEvent } from "@uptimizr/schema";
import { buildSessionNarrative, renderSessionNarrativeText } from "../narrative/index.js";

const T0 = 1_760_000_000_000;
const PROJECT = "p1";
const SESSION = "s1";

/** Marker values that must never reach the narrative (ADR 0003). */
const VISITOR = "visitor-hash-do-not-leak";
const URL = "https://shop.example.com/checkout?coupon=SECRET";

/** Build one event with the privacy-sensitive envelope fields always filled. */
function ev(
  type: string,
  atMs: number,
  extra: Record<string, unknown> = {},
  sceneId = "lobby",
): AnyEvent {
  return {
    type,
    projectId: PROJECT,
    sessionId: SESSION,
    visitorId: VISITOR,
    ts: T0 + atMs,
    sdkVersion: "1.0.0",
    sceneId,
    url: URL,
    pageMeta: { title: "Checkout — Example Shop", referrer: URL, language: "en-GB" },
    ...extra,
  } as unknown as AnyEvent;
}

/**
 * A session that walks from `lobby` to `arena`, looks at two meshes, interacts
 * four different ways, stutters once, errors once, loses tracking, brushes the
 * guardian and ends on `unload`.
 */
const SESSION_EVENTS: AnyEvent[] = [
  ev("session_start", 0, {
    device: {
      engine: "webgl2",
      renderer: "Apple M2 Pro",
      vendor: "Apple",
      os: "macOS",
      browser: "Safari",
      isMobile: false,
    },
    graphics: { api: "webgl2", backend: "metal" },
    user: { id: "customer-4711", traits: { plan: "pro" } },
  }),
  ev("frame_perf", 500, { fps: 60 }),
  // Two visibility samples for the same mesh: folded into one dwell entry.
  ev("mesh_visibility", 1_000, { mesh: "statue", visibleMs: 900 }),
  ev("mesh_visibility", 2_000, { mesh: "statue", visibleMs: 700 }),
  // Below the default floor on its own — stays out unless `minDwellMs` drops.
  ev("mesh_visibility", 2_500, { mesh: "bench", visibleMs: 400 }),
  ev("hover_dwell", 3_000, { mesh: "statue", dwellMs: 250, source: "mouse" }),
  ev("mesh_interaction", 3_500, { mesh: "buy", kind: "click", source: "mouse" }),
  // A click that hit nothing is not a story; a click that hit a mesh is.
  ev("pointer_click", 3_600, { screen: [0.5, 0.5] }),
  ev("pointer_click", 3_700, { hitMesh: "poster", source: "touch" }),
  ev("input_action", 4_000, { action: "jump", code: "Space", source: "keyboard" }),
  ev("custom", 4_500, {
    name: "add_to_cart",
    props: { sku: "SKU-9911", price: 42, customerEmail: "buyer@example.com" },
  }),
  ev("scene_change", 5_000, {}, "arena"),
  // A three-sample dip: one entry, not three.
  ev("frame_perf", 6_000, { fps: 22 }, "arena"),
  ev("frame_perf", 6_500, { fps: 14 }, "arena"),
  ev("frame_perf", 7_000, { fps: 18 }, "arena"),
  ev("frame_perf", 7_500, { fps: 58 }, "arena"),
  // A single sub-threshold sample is noise, not a dip.
  ev("frame_perf", 8_000, { fps: 21 }, "arena"),
  ev("frame_perf", 8_500, { fps: 59 }, "arena"),
  ev("runtime_error", 9_000, {
    kind: "error",
    message: "TypeError: cannot read property 'mesh' of undefined",
    source: URL,
    stack: `at checkout (${URL}:42:7)`,
  }),
  ev("graphics_diagnostic", 9_500, { severity: "warning", category: "shader-compile", count: 3 }),
  ev("capability_change", 10_000, {
    kind: "tracking",
    from: "tracked",
    to: "degraded",
    durationMs: 1_200,
    source: "hand",
  }),
  ev("mesh_interaction", 10_500, { mesh: "portal", kind: "teleport", source: "xr-controller" }),
  ev("xr_boundary_proximity", 11_000, { position: [1, 0, 1], durationMs: 300 }),
  ev("xr_boundary_proximity", 11_500, { position: [1, 0, 1], durationMs: 500 }),
  ev("session_end", 12_000, { reason: "unload", durationMs: 12_000 }),
];

const narrative = buildSessionNarrative(SESSION_EVENTS);
const kinds = narrative.entries.map((entry) => entry.kind);
const summaries = narrative.entries.map((entry) => entry.summary);
const entryOf = (predicate: (summary: string) => boolean) =>
  narrative.entries.find((entry) => predicate(entry.summary));

describe("buildSessionNarrative — shape and ordering", () => {
  it("is ordered by relative time and starts at zero", () => {
    const times = narrative.entries.map((entry) => entry.tMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(0);
    // Relative, never wall-clock: nothing may be anywhere near the epoch base.
    for (const t of times) expect(t).toBeLessThan(60_000);
  });

  it("opens with the scene and closes with the summary", () => {
    expect(kinds[0]).toBe("scene");
    expect(kinds.at(-1)).toBe("summary");
    // Exactly one summary entry, and it is the last one.
    expect(kinds.filter((kind) => kind === "summary")).toHaveLength(1);
    expect(narrative.sessionId).toBe(SESSION);
    expect(narrative.startedAt).toBe(T0);
  });

  it("reports the totals the closing entry carries", () => {
    const summary = narrative.entries.at(-1)!;
    expect(summary.totals).toEqual(narrative.totals);
    expect(summary.truncated).toBe(false);
    expect(narrative.totals).toEqual({
      events: SESSION_EVENTS.length,
      durationMs: 12_000,
      scenes: 2,
      meshes: 5,
      interactions: 5,
      dips: 1,
      errors: 1,
    });
  });

  it("names both scenes it visited", () => {
    const scenes = narrative.entries.filter((entry) => entry.kind === "scene");
    expect(scenes.map((entry) => entry.refs.scene)).toEqual(["lobby", "arena"]);
    expect(scenes[0]!.summary).toContain("webgl2");
  });

  it("ends with the reported reason and duration", () => {
    const end = narrative.entries.find((entry) => entry.kind === "end")!;
    expect(end.summary).toBe("Session ended (unload) after 12.0s.");
    expect(end.durationMs).toBe(12_000);
  });
});

describe("buildSessionNarrative — dwell", () => {
  it("folds every dwell sample for one mesh into a single entry", () => {
    const statue = narrative.entries.filter((entry) => entry.refs.mesh === "statue");
    expect(statue.filter((entry) => entry.kind === "dwell")).toHaveLength(1);
    const dwell = statue.find((entry) => entry.kind === "dwell")!;
    // 900 + 700 visible + 250 hovered.
    expect(dwell.durationMs).toBe(1_850);
    expect(dwell.count).toBe(3);
    // Positioned at the FIRST sighting, not at the last.
    expect(dwell.tMs).toBe(1_000);
    expect(dwell.summary).toContain("250ms hovered");
  });

  it("drops a mesh below the dwell floor, and keeps it when the floor drops", () => {
    expect(narrative.entries.some((entry) => entry.refs.mesh === "bench")).toBe(false);
    const loose = buildSessionNarrative(SESSION_EVENTS, { minDwellMs: 100 });
    expect(
      loose.entries.some((entry) => entry.kind === "dwell" && entry.refs.mesh === "bench"),
    ).toBe(true);
    // The floor only changes which meshes are *reported*, never the totals.
    expect(loose.totals.meshes).toBe(narrative.totals.meshes);
  });
});

describe("buildSessionNarrative — interactions", () => {
  it("records each interaction kind once, and ignores a click that hit nothing", () => {
    const interactions = narrative.entries.filter((entry) => entry.kind === "interaction");
    expect(interactions.map((entry) => entry.summary)).toEqual([
      'click on "buy" via mouse.',
      'Clicked "poster" via touch.',
      'Input action "jump" (Space) via keyboard.',
      'Custom event "add_to_cart" (customerEmail, price, sku).',
      'teleport on "portal" via xr-controller.',
    ]);
    // The 3 600 ms click hit no mesh and contributes nothing.
    expect(interactions.some((entry) => entry.tMs === 3_600)).toBe(false);
  });

  it("names custom property keys but never their values", () => {
    const custom = entryOf((summary) => summary.includes("add_to_cart"))!;
    expect(custom.refs.name).toBe("add_to_cart");
    expect(custom.summary).toContain("sku");
    expect(custom.summary).not.toContain("SKU-9911");
    expect(custom.summary).not.toContain("buyer@example.com");
  });

  it("includes the values only when the caller opts in", () => {
    const opted = buildSessionNarrative(SESSION_EVENTS, { includeCustomProps: true });
    const custom = opted.entries.find((entry) => entry.refs.name === "add_to_cart")!;
    expect(custom.summary).toContain("sku=SKU-9911");
  });
});

describe("buildSessionNarrative — perf dips", () => {
  it("collapses a run of sub-threshold samples into one entry", () => {
    const dipEntries = narrative.entries.filter((entry) => entry.kind === "perf_dip");
    expect(dipEntries).toHaveLength(1);
    const [dip] = dipEntries;
    expect(dip!.tMs).toBe(6_000);
    expect(dip!.count).toBe(3);
    expect(dip!.durationMs).toBe(1_000);
    // The worst sample in the run, and the run mean — not one entry per sample.
    expect(dip!.summary).toBe("Frame rate dipped to 14 fps (mean 18) across 3 samples over 1.0s.");
    expect(dip!.refs.scene).toBe("arena");
  });

  it("ignores a single unlucky sample", () => {
    // The lone 21 fps sample at 8 000 ms is below threshold but alone.
    expect(NARRATIVE_LIMITS.dipMinSamples).toBe(2);
    expect(
      narrative.entries.some((entry) => entry.kind === "perf_dip" && entry.tMs === 8_000),
    ).toBe(false);
  });

  it("follows the caller's threshold", () => {
    // At 59 fps the 58 fps sample joins the run — and with it the lone 21 fps
    // sample that follows, which no longer has a healthy sample separating it —
    // so the three-sample dip becomes one five-sample dip.
    const strict = buildSessionNarrative(SESSION_EVENTS, { fpsThreshold: 59 });
    const strictDip = strict.entries.find((entry) => entry.kind === "perf_dip")!;
    expect(strictDip.count).toBe(5);
    expect(strict.totals.dips).toBe(1);
    // Below every sample in the session, nothing dipped at all.
    const lenient = buildSessionNarrative(SESSION_EVENTS, { fpsThreshold: 10 });
    expect(lenient.totals.dips).toBe(0);
    expect(lenient.entries.some((entry) => entry.kind === "perf_dip")).toBe(false);
  });
});

describe("buildSessionNarrative — errors, capability and XR", () => {
  it("truncates the error message and never carries its source or stack", () => {
    const error = narrative.entries.find((entry) => entry.kind === "error")!;
    expect(error.summary).toBe(
      "Runtime error: TypeError: cannot read property 'mesh' of undefined",
    );
    const long = buildSessionNarrative([
      ev("session_start", 0),
      ev("runtime_error", 10, { kind: "error", message: "x".repeat(900) }),
    ]);
    const truncatedError = long.entries.find((entry) => entry.kind === "error")!;
    expect(truncatedError.summary.length).toBeLessThan(
      NARRATIVE_LIMITS.maxMessageLength + "Runtime error: ".length + 2,
    );
    expect(truncatedError.summary.endsWith("…")).toBe(true);
  });

  it("reports a diagnostic by category and severity only", () => {
    const diagnostic = narrative.entries.find((entry) => entry.kind === "diagnostic")!;
    expect(diagnostic.summary).toBe("Graphics diagnostic: shader-compile (warning).");
    expect(diagnostic.count).toBe(3);
  });

  it("reports the capability transition and how long it lasted", () => {
    const capability = narrative.entries.find((entry) => entry.kind === "capability")!;
    expect(capability.summary).toBe("Capability change (tracking): tracked → degraded for 1.2s.");
    expect(capability.durationMs).toBe(1_200);
  });

  it("brackets the immersive stretch and folds the boundary contacts", () => {
    const xr = narrative.entries.filter((entry) => entry.kind === "xr");
    expect(xr).toHaveLength(3);
    // The first XR-sourced event is the hand-tracking capability change at
    // 10 000 ms, not the controller teleport that follows it: XR is an input
    // source in this schema (ADR 0011), never an explicit mode event.
    expect(xr[0]!.summary).toBe("Entered immersive XR input (hand).");
    expect(xr[0]!.tMs).toBe(10_000);
    const boundary = xr.find((entry) => entry.summary.includes("boundary"))!;
    expect(boundary.count).toBe(2);
    expect(boundary.durationMs).toBe(800);
  });
});

describe("buildSessionNarrative — bounds", () => {
  it("honours maxEntries and always keeps the summary", () => {
    const bounded = buildSessionNarrative(SESSION_EVENTS, { maxEntries: 5 });
    expect(bounded.entries).toHaveLength(5);
    expect(bounded.entries.at(-1)!.kind).toBe("summary");
    expect(bounded.truncated).toBe(true);
    expect(bounded.entries.at(-1)!.truncated).toBe(true);
    expect(bounded.entries.at(-1)!.summary).toContain("dropped");
    // Truncation never changes the totals — they describe the session, not the page.
    expect(bounded.totals).toEqual(narrative.totals);
  });

  it("clamps an out-of-range cap to the registry hard cap", () => {
    const many: AnyEvent[] = [ev("session_start", 0)];
    for (let i = 0; i < 2_000; i += 1) {
      many.push(ev("custom", i + 1, { name: `step_${i}` }));
    }
    const huge = buildSessionNarrative(many, { maxEntries: 10_000 });
    expect(huge.entries).toHaveLength(NARRATIVE_LIMITS.maxMaxEntries);
    expect(huge.truncated).toBe(true);
  });

  it("defaults to the 200-entry bound issue #314 asks for", () => {
    expect(NARRATIVE_LIMITS.defaultMaxEntries).toBe(200);
    const many: AnyEvent[] = [ev("session_start", 0)];
    for (let i = 0; i < 500; i += 1) many.push(ev("custom", i + 1, { name: `step_${i}` }));
    expect(buildSessionNarrative(many).entries).toHaveLength(200);
  });

  it("sorts an out-of-order stream and survives an empty one", () => {
    const shuffled = [...SESSION_EVENTS].reverse();
    expect(buildSessionNarrative(shuffled).entries.map((e) => e.tMs)).toEqual(
      narrative.entries.map((e) => e.tMs),
    );
    const none = buildSessionNarrative([]);
    expect(none.entries).toEqual([]);
    expect(none.totals.events).toBe(0);
  });
});

describe("buildSessionNarrative — privacy (ADR 0003)", () => {
  const serialised = JSON.stringify(narrative);

  it("carries no visitor hash, URL or page metadata", () => {
    for (const secret of [
      VISITOR,
      URL,
      "shop.example.com",
      "Checkout — Example Shop",
      "en-GB",
      "SKU-9911",
      "buyer@example.com",
    ]) {
      expect(serialised, `narrative leaked ${secret}`).not.toContain(secret);
    }
  });

  it("carries no device detail beyond the rendering engine", () => {
    for (const detail of ["Apple M2 Pro", "Apple", "macOS", "Safari"]) {
      expect(serialised, `narrative leaked ${detail}`).not.toContain(detail);
    }
    expect(serialised).toContain("webgl2");
  });

  it("carries nothing from the app-supplied user descriptor", () => {
    expect(serialised).not.toContain("customer-4711");
    expect(serialised).not.toContain("plan");
  });

  it("carries no positions, rays or screen coordinates", () => {
    for (const entry of narrative.entries) {
      expect(Object.keys(entry.refs).every((key) => ["mesh", "scene", "name"].includes(key))).toBe(
        true,
      );
      for (const forbidden of ["position", "hitPoint", "ray", "uv", "screen"]) {
        expect(JSON.stringify(entry)).not.toContain(forbidden);
      }
    }
  });
});

describe("renderSessionNarrativeText", () => {
  const text = renderSessionNarrativeText(narrative);

  it("renders one line per entry plus a header", () => {
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(narrative.entries.length + 1);
    expect(lines[0]).toContain(`session ${SESSION}`);
    expect(lines[0]).toContain(`${narrative.totals.events} events`);
    for (const [index, entry] of narrative.entries.entries()) {
      expect(lines[index + 1]).toContain(entry.summary);
      expect(lines[index + 1]).toContain(entry.kind);
    }
  });

  it("stays well under 200 lines for a real-sized session, and marks truncation", () => {
    expect(text.trimEnd().split("\n").length).toBeLessThan(200);
    const bounded = renderSessionNarrativeText(
      buildSessionNarrative(SESSION_EVENTS, { maxEntries: 4 }),
    );
    expect(bounded.split("\n")[0]).toContain("(truncated)");
  });

  it("leaks nothing the structured narrative does not", () => {
    for (const secret of [VISITOR, URL, "Apple M2 Pro", "customer-4711", "buyer@example.com"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("summaries", () => {
  it("are one line each and never empty", () => {
    for (const summary of summaries) {
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).not.toContain("\n");
      expect(summary.length).toBeLessThanOrEqual(400);
    }
  });
});
