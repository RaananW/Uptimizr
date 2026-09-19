/**
 * `buildSessionNarrative` — the pure compaction behind
 * `GET /api/v1/sessions/:id/narrative` (ADR 0051 §7, design sketch §G.2).
 *
 * It turns one session's raw event stream into an ordered, bounded account of
 * what that session *did*: where it went, what held its attention, what it
 * touched, what stuttered, what broke, and how it ended. Timestamps are relative
 * to the session's first event, every line of prose is templated from the
 * entry's own fields, and the whole thing is capped by `maxEntries`.
 *
 * **Pure.** It takes an `AnyEvent[]` and returns a plain object: no store, no
 * request, no clock, no I/O. It lives in `@uptimizr/db` rather than in
 * `@uptimizr/agent-core` because the collector is the only consumer and
 * `agent-core` must stay browser-safe and driver-free; it is not in
 * `@uptimizr/metrics` because that package is pure *data*.
 *
 * ## What it deliberately leaves out (ADR 0003)
 *
 * A narrative is derived from raw per-session data, so the route that serves it
 * needs both `ENABLE_RAW_SESSION_RETENTION` and a `query:raw` key. The
 * compaction is the second line of defence: it is an allow-list, not a redactor.
 * It reads only the fields named below, so nothing else can leak even if a
 * future event type carries it —
 *
 * - **never** `visitorId`, `url` or `pageMeta` (title, referrer, language, …);
 * - **never** a position, hit point, ray, UV or screen coordinate;
 * - from `device`/`graphics`, only the rendering `engine` and graphics `api` —
 *   no renderer string, no vendor, no OS, no browser, no memory or core count;
 * - from `session_start.user`, nothing at all;
 * - custom-event property **keys** (developer-chosen field names), never their
 *   values, unless the caller explicitly passes `includeCustomProps`;
 * - `runtime_error.message` truncated, and never its `source` (a URL) or
 *   `stack`;
 * - `graphics_diagnostic` by `category`/`severity` only — never its message.
 *
 * `src/__tests__/narrative.test.ts` asserts the exclusions against a synthetic
 * session whose every event carries a visitor hash, a URL and page metadata.
 */

import {
  NARRATIVE_LIMITS,
  type SessionNarrativeEntry,
  type SessionNarrativeTotals,
} from "@uptimizr/metrics";
import type { AnyEvent } from "@uptimizr/schema";

/** How to compact a session. Every field has a registry-declared default. */
export interface SessionNarrativeOptions {
  /** Dwell floor in ms; a mesh below it is a glance, not attention. */
  minDwellMs?: number;
  /** A `frame_perf` sample below this FPS counts towards a dip. */
  fpsThreshold?: number;
  /** Hard cap on entries, closing `summary` entry included. */
  maxEntries?: number;
  /**
   * Include custom-event property **values** as well as their keys. Off by
   * default: a property value is app-supplied and may carry anything, so it is
   * outside the privacy allow-list unless the operator opts in.
   */
  includeCustomProps?: boolean;
}

/** An ordered, bounded account of one session. */
export interface SessionNarrative {
  /** The session the narrative describes. */
  sessionId: string;
  /** Wall-clock start of the session (epoch ms) — the origin `tMs` counts from. */
  startedAt: number;
  /** The entries, oldest first, ending with the `summary` entry. */
  entries: SessionNarrativeEntry[];
  /** Whether entries were dropped to honour `maxEntries`. */
  truncated: boolean;
  /** Session-wide totals, also carried on the closing `summary` entry. */
  totals: SessionNarrativeTotals;
}

/** Input sources that mean "this was an immersive XR session" (ADR 0011). */
const XR_SOURCES = new Set(["xr-controller", "hand", "gaze", "transient"]);

/** Clamp `value` into `[min, max]`, falling back to `fallback` when absent. */
function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Collapse whitespace and cut to `max` characters, marking the cut with `…`. */
function truncate(text: string, max: number = NARRATIVE_LIMITS.maxMessageLength): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** `3400` → `"3.4s"`, `900` → `"900ms"` — durations a reader can skim. */
function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** A number rendered for prose: one decimal place, no trailing `.0`. */
function humanNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** `via mouse` / `` — the input source clause, when the event carried one. */
function sourceClause(source: unknown): string {
  return typeof source === "string" && source.length > 0 ? ` via ${source}` : "";
}

/** Drop the `undefined` keys so `refs` serialises as only what it really has. */
function refsOf(refs: { mesh?: string; scene?: string; name?: string }): {
  mesh?: string;
  scene?: string;
  name?: string;
} {
  const out: { mesh?: string; scene?: string; name?: string } = {};
  if (refs.mesh) out.mesh = refs.mesh;
  if (refs.scene) out.scene = refs.scene;
  if (refs.name) out.name = refs.name;
  return out;
}

/** Per-mesh attention accumulated across the session. */
interface DwellAccumulator {
  mesh: string;
  scene?: string;
  /** First moment the mesh was seen, relative to the session start. */
  tMs: number;
  /** Summed `mesh_visibility.visibleMs`. */
  visibleMs: number;
  /** Summed `hover_dwell.dwellMs`. */
  hoverMs: number;
  /** Source events folded in. */
  count: number;
}

/** A run of consecutive sub-threshold `frame_perf` samples. */
interface DipAccumulator {
  tMs: number;
  endTMs: number;
  samples: number;
  minFps: number;
  scene?: string;
  /** Summed FPS, for the run's mean. */
  totalFps: number;
}

/**
 * Compact one session's events into a narrative.
 *
 * `events` may arrive in any order (they are sorted here, stably, so events
 * sharing a timestamp keep their stream order) and may be empty — an empty
 * session yields an empty narrative with zeroed totals, which the collector
 * turns into a 404.
 */
export function buildSessionNarrative(
  events: readonly AnyEvent[],
  options: SessionNarrativeOptions = {},
): SessionNarrative {
  const minDwellMs = clamp(
    options.minDwellMs,
    NARRATIVE_LIMITS.defaultMinDwellMs,
    0,
    NARRATIVE_LIMITS.maxMinDwellMs,
  );
  const fpsThreshold = clamp(
    options.fpsThreshold,
    NARRATIVE_LIMITS.defaultFpsThreshold,
    1,
    NARRATIVE_LIMITS.maxFpsThreshold,
  );
  const maxEntries = Math.round(
    clamp(
      options.maxEntries,
      NARRATIVE_LIMITS.defaultMaxEntries,
      1,
      NARRATIVE_LIMITS.maxMaxEntries,
    ),
  );

  const ordered = [...events]
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.ts - b.event.ts || a.index - b.index)
    .map((entry) => entry.event);

  const empty: SessionNarrativeTotals = {
    events: 0,
    durationMs: 0,
    scenes: 0,
    meshes: 0,
    interactions: 0,
    dips: 0,
    errors: 0,
  };
  const first = ordered[0];
  if (!first) {
    return { sessionId: "", startedAt: 0, entries: [], truncated: false, totals: empty };
  }

  const t0 = first.ts;
  const rel = (ts: number): number => Math.max(0, Math.round(ts - t0));

  const entries: SessionNarrativeEntry[] = [];
  const push = (entry: SessionNarrativeEntry): void => {
    entries.push(entry);
  };

  const dwell = new Map<string, DwellAccumulator>();
  const scenes = new Set<string>();
  const meshes = new Set<string>();
  let interactions = 0;
  let dips = 0;
  let errors = 0;

  let dip: DipAccumulator | null = null;
  let xrFirstTMs: number | null = null;
  let xrLastTMs: number | null = null;
  let xrSource = "";
  let boundaryCount = 0;
  let boundaryMs = 0;
  let boundaryTMs = 0;
  let lastTs = first.ts;

  /** Fold a dwell contribution for `mesh` into the accumulator. */
  const addDwell = (
    mesh: string,
    tMs: number,
    scene: string | undefined,
    visibleMs: number,
    hoverMs: number,
  ): void => {
    meshes.add(mesh);
    const existing = dwell.get(mesh);
    if (existing) {
      existing.visibleMs += visibleMs;
      existing.hoverMs += hoverMs;
      existing.count += 1;
      if (tMs < existing.tMs) existing.tMs = tMs;
      return;
    }
    dwell.set(mesh, { mesh, scene, tMs, visibleMs, hoverMs, count: 1 });
  };

  /** Close the open perf dip, emitting an entry when it is long enough. */
  const closeDip = (): void => {
    if (!dip) return;
    if (dip.samples >= NARRATIVE_LIMITS.dipMinSamples) {
      const durationMs = Math.max(0, dip.endTMs - dip.tMs);
      dips += 1;
      push({
        tMs: dip.tMs,
        kind: "perf_dip",
        summary:
          `Frame rate dipped to ${humanNumber(dip.minFps)} fps ` +
          `(mean ${humanNumber(dip.totalFps / dip.samples)}) across ${dip.samples} samples` +
          (durationMs > 0 ? ` over ${humanMs(durationMs)}.` : "."),
        refs: refsOf({ scene: dip.scene }),
        ...(durationMs > 0 ? { durationMs } : {}),
        count: dip.samples,
      });
    }
    dip = null;
  };

  for (const event of ordered) {
    lastTs = event.ts;
    const tMs = rel(event.ts);
    const scene = typeof event.sceneId === "string" ? event.sceneId : undefined;
    if (scene) scenes.add(scene);

    // Anything with an XR input source marks the immersive stretch of the
    // session. There is no explicit "entered XR" event (ADR 0011 models XR as an
    // input source, not a mode), so the span is derived from the first and last
    // XR-sourced event.
    const source = (event as { source?: unknown }).source;
    if (typeof source === "string" && XR_SOURCES.has(source)) {
      if (xrFirstTMs == null) {
        xrFirstTMs = tMs;
        xrSource = source;
      }
      xrLastTMs = tMs;
    }

    switch (event.type) {
      case "session_start": {
        const engine = event.device?.engine;
        const api = event.graphics?.api;
        const renderer = engine ?? api;
        push({
          tMs,
          kind: "scene",
          summary:
            (scene ? `Session started in scene "${scene}"` : "Session started") +
            (renderer ? ` on ${renderer}.` : "."),
          refs: refsOf({ scene }),
        });
        break;
      }
      case "scene_change": {
        push({
          tMs,
          kind: "scene",
          summary: scene ? `Moved to scene "${scene}".` : "Moved to another scene.",
          refs: refsOf({ scene }),
        });
        break;
      }
      case "mesh_visibility": {
        addDwell(event.mesh, tMs, scene, event.visibleMs, 0);
        break;
      }
      case "hover_dwell": {
        addDwell(event.mesh, tMs, scene, 0, event.dwellMs);
        break;
      }
      case "mesh_interaction": {
        meshes.add(event.mesh);
        interactions += 1;
        push({
          tMs,
          kind: "interaction",
          summary: `${event.kind} on "${event.mesh}"${sourceClause(event.source)}.`,
          refs: refsOf({ mesh: event.mesh, scene }),
        });
        break;
      }
      case "pointer_click": {
        // Only a click that hit something is a story. A click into empty space
        // carries nothing but coordinates, which a narrative never reports —
        // `dead_clicks` is the aggregate metric for those.
        if (!event.hitMesh) break;
        meshes.add(event.hitMesh);
        interactions += 1;
        push({
          tMs,
          kind: "interaction",
          summary: `Clicked "${event.hitMesh}"${sourceClause(event.source)}.`,
          refs: refsOf({ mesh: event.hitMesh, scene }),
        });
        break;
      }
      case "input_action": {
        interactions += 1;
        const state = event.pressed === false ? " released" : "";
        push({
          tMs,
          kind: "interaction",
          summary:
            `Input action "${event.action}"${event.code ? ` (${event.code})` : ""}` +
            `${state}${sourceClause(event.source)}.`,
          refs: refsOf({ name: event.action, scene }),
        });
        break;
      }
      case "custom": {
        interactions += 1;
        const props = event.props ?? {};
        const keys = Object.keys(props).sort().slice(0, NARRATIVE_LIMITS.maxCustomPropKeys);
        // Keys are developer-chosen field names and are always safe to name;
        // values are app data and are opt-in only (see the module comment).
        const detail = options.includeCustomProps
          ? keys.map((key) => `${key}=${truncate(String(props[key]), 40)}`).join(", ")
          : keys.join(", ");
        push({
          tMs,
          kind: "interaction",
          summary: `Custom event "${event.name}"${detail ? ` (${detail})` : ""}.`,
          refs: refsOf({ name: event.name, scene }),
        });
        break;
      }
      case "frame_perf": {
        if (event.fps < fpsThreshold) {
          if (dip == null) {
            dip = {
              tMs,
              endTMs: tMs,
              samples: 1,
              minFps: event.fps,
              scene,
              totalFps: event.fps,
            };
          } else {
            dip.endTMs = tMs;
            dip.samples += 1;
            dip.totalFps += event.fps;
            if (event.fps < dip.minFps) dip.minFps = event.fps;
          }
        } else {
          closeDip();
        }
        break;
      }
      case "runtime_error": {
        errors += 1;
        // The message only — never `source` (a URL) or `stack`.
        push({
          tMs,
          kind: "error",
          summary: `Runtime ${event.kind}: ${truncate(event.message)}`,
          refs: refsOf({ scene }),
        });
        break;
      }
      case "graphics_diagnostic": {
        if (event.severity === "error" || event.severity === "fatal") errors += 1;
        // Category and severity are closed enums; the engine's own message is
        // not reported.
        push({
          tMs,
          kind: "diagnostic",
          summary: `Graphics diagnostic: ${event.category} (${event.severity}).`,
          refs: refsOf({ scene }),
          ...(event.count != null ? { count: event.count } : {}),
        });
        break;
      }
      case "capability_change": {
        const from = event.from ? truncate(event.from, 64) : undefined;
        const to = event.to ? truncate(event.to, 64) : undefined;
        const transition = from && to ? `: ${from} → ${to}` : to ? `: → ${to}` : "";
        const durationMs = event.durationMs != null ? Math.round(event.durationMs) : undefined;
        push({
          tMs,
          kind: "capability",
          summary:
            `Capability change (${event.kind})${transition}` +
            (durationMs != null ? ` for ${humanMs(durationMs)}.` : "."),
          refs: refsOf({ scene }),
          ...(durationMs != null ? { durationMs } : {}),
        });
        break;
      }
      case "xr_boundary_proximity": {
        // Folded into one summary entry rather than one per contact: a guardian
        // approach fires repeatedly and would otherwise flood the narrative.
        if (boundaryCount === 0) boundaryTMs = tMs;
        boundaryCount += 1;
        boundaryMs += event.durationMs;
        break;
      }
      case "session_end": {
        closeDip();
        const durationMs =
          event.durationMs != null ? Math.round(event.durationMs) : Math.max(0, tMs);
        push({
          tMs,
          kind: "end",
          summary: `Session ended${event.reason ? ` (${event.reason})` : ""} after ${humanMs(durationMs)}.`,
          refs: refsOf({ scene }),
          durationMs,
        });
        break;
      }
      default:
        break;
    }
  }

  closeDip();

  // --- deferred, session-wide entries -------------------------------------

  for (const accumulator of dwell.values()) {
    const totalMs = Math.round(accumulator.visibleMs + accumulator.hoverMs);
    if (totalMs < minDwellMs) continue;
    const hover =
      accumulator.hoverMs > 0 ? ` (${humanMs(Math.round(accumulator.hoverMs))} hovered)` : "";
    push({
      tMs: accumulator.tMs,
      kind: "dwell",
      summary: `Dwelled on "${accumulator.mesh}" for ${humanMs(totalMs)}${hover}.`,
      refs: refsOf({ mesh: accumulator.mesh, scene: accumulator.scene }),
      durationMs: totalMs,
      count: accumulator.count,
    });
  }

  if (xrFirstTMs != null) {
    push({
      tMs: xrFirstTMs,
      kind: "xr",
      summary: `Entered immersive XR input (${xrSource}).`,
      refs: {},
    });
    if (xrLastTMs != null && xrLastTMs > xrFirstTMs) {
      push({
        tMs: xrLastTMs,
        kind: "xr",
        summary: `Last immersive XR input, ${humanMs(xrLastTMs - xrFirstTMs)} after the first.`,
        refs: {},
        durationMs: xrLastTMs - xrFirstTMs,
      });
    }
  }

  if (boundaryCount > 0) {
    push({
      tMs: boundaryTMs,
      kind: "xr",
      summary: `Approached the play-area boundary ${boundaryCount} time(s) for ${humanMs(
        Math.round(boundaryMs),
      )} in total.`,
      refs: {},
      durationMs: Math.round(boundaryMs),
      count: boundaryCount,
    });
  }

  // --- order, bound, summarise --------------------------------------------

  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.tMs - b.entry.tMs || a.index - b.index)
    .map((item) => item.entry);

  // The closing `summary` entry always survives, so the bound the caller asked
  // for is the bound on the whole answer — never `maxEntries + 1`.
  const room = Math.max(0, maxEntries - 1);
  const truncated = sorted.length > room;
  const kept = truncated ? sorted.slice(0, room) : sorted;

  const totals: SessionNarrativeTotals = {
    events: ordered.length,
    durationMs: Math.max(0, Math.round(lastTs - t0)),
    scenes: scenes.size,
    meshes: meshes.size,
    interactions,
    dips,
    errors,
  };

  kept.push({
    tMs: totals.durationMs,
    kind: "summary",
    summary:
      `${totals.events} events over ${humanMs(totals.durationMs)}: ${totals.scenes} scene(s), ` +
      `${totals.meshes} mesh(es), ${totals.interactions} interaction(s), ${totals.dips} perf dip(s), ` +
      `${totals.errors} error(s).` +
      (truncated
        ? ` ${sorted.length - room} later entr(ies) were dropped to honour maxEntries.`
        : ""),
    refs: {},
    totals,
    truncated,
  });

  return { sessionId: first.sessionId, startedAt: t0, entries: kept, truncated, totals };
}
