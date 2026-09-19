/**
 * The **session narrative** contract (ADR 0051 §7, design sketch §G.2).
 *
 * A narrative is an ordered, compacted account of what one session did — scene
 * changes, mesh dwell, interactions, performance dips, errors and the reason it
 * ended — with every timestamp relative to the session's first event. It exists
 * because the two things an agent could otherwise ask for are both useless to
 * it: the aggregate metrics say nothing about *one* session, and the raw NDJSON
 * stream is tens of thousands of lines of sampled telemetry.
 *
 * Only the **shapes and bounds** live here, in the dependency-free registry
 * package, because three packages need them and none of them may depend on the
 * others:
 *
 * - `@uptimizr/db` computes a narrative from `AnyEvent[]` (`src/narrative/`);
 * - the collector serves it on `GET /api/v1/sessions/:id/narrative` and bounds
 *   its querystring with the same numbers;
 * - the registry entry below it (`session_narrative`) advertises the row schema
 *   to OpenAPI, the agent tool catalog and the docs tables.
 *
 * **Privacy (ADR 0003).** A narrative is derived from raw per-session events, so
 * it is reachable only on a collector with `ENABLE_RAW_SESSION_RETENTION` and
 * only with a key holding `query:raw`. Even then it is a *projection*: an entry
 * carries a relative timestamp, a templated one-line summary and at most a mesh
 * name, a scene id and a custom-event name. It never carries the visitor hash,
 * the page URL, `pageMeta`, positions, rays, or anything from the `device` block
 * beyond the engine/graphics API. Custom-event **property values** are excluded
 * unless the caller explicitly asks for them; the property *keys* are always
 * safe to show because they are developer-chosen field names.
 */

import { z } from "zod";

/**
 * What one narrative entry is about.
 *
 * - `scene` — the session entered a scene (`session_start` or `scene_change`).
 * - `dwell` — a mesh held the viewer's attention for at least `minDwellMs`,
 *   aggregated across the session from `mesh_visibility` / `hover_dwell`.
 * - `interaction` — a discrete act: a mesh interaction, a click that hit a mesh,
 *   a named input action, or a custom event.
 * - `perf_dip` — a run of consecutive `frame_perf` samples below `fpsThreshold`,
 *   collapsed into one entry with the run's duration and sample count.
 * - `error` — a `runtime_error`, message truncated.
 * - `diagnostic` — a `graphics_diagnostic`, by category and severity.
 * - `capability` — a `capability_change` (quality drop, tracking loss, backend
 *   fallback).
 * - `xr` — entering/leaving immersive input, and a boundary-proximity summary.
 * - `end` — how the session finished (`session_end` reason), when it reported.
 * - `summary` — the single closing entry carrying the session's totals.
 */
export const NARRATIVE_ENTRY_KINDS = [
  "scene",
  "dwell",
  "interaction",
  "perf_dip",
  "error",
  "diagnostic",
  "capability",
  "xr",
  "end",
  "summary",
] as const;

/** One narrative entry kind. */
export type NarrativeEntryKind = (typeof NARRATIVE_ENTRY_KINDS)[number];

/** {@link NARRATIVE_ENTRY_KINDS} as a Zod enum. */
export const narrativeEntryKindSchema = z.enum(NARRATIVE_ENTRY_KINDS);

/**
 * The named things an entry points at. Deliberately only three, and all three
 * are developer-assigned identifiers rather than anything about a person: the
 * mesh/object name, the scene id, and the name of a custom event or input
 * action.
 */
export const narrativeRefsSchema = z.object({
  mesh: z.string().optional(),
  scene: z.string().optional(),
  name: z.string().optional(),
});

/** What an entry points at — see {@link narrativeRefsSchema}. */
export type NarrativeRefs = z.infer<typeof narrativeRefsSchema>;

/**
 * Session-wide totals, carried on the closing `summary` entry so a reader that
 * only keeps the last line still knows the shape of what it just read.
 */
export const sessionNarrativeTotalsSchema = z.object({
  /** Events the narrative was compacted from (every type, before filtering). */
  events: z.number().int().nonnegative(),
  /** Wall-clock span of the session, first to last event. */
  durationMs: z.number().int().nonnegative(),
  /** Distinct scene ids visited. */
  scenes: z.number().int().nonnegative(),
  /** Distinct mesh names the session touched or dwelled on. */
  meshes: z.number().int().nonnegative(),
  /** Interaction entries (mesh interactions, clicks, input actions, customs). */
  interactions: z.number().int().nonnegative(),
  /** Performance dips detected. */
  dips: z.number().int().nonnegative(),
  /** Runtime errors plus `error`/`fatal` graphics diagnostics. */
  errors: z.number().int().nonnegative(),
});

/** Session-wide totals — see {@link sessionNarrativeTotalsSchema}. */
export type SessionNarrativeTotals = z.infer<typeof sessionNarrativeTotalsSchema>;

/**
 * One line of the narrative.
 *
 * `summary` is a **templated** one-line sentence composed from the fields
 * already on the entry — never free text copied out of an event payload — so
 * that what an LLM reads cannot contain anything the structured fields do not.
 */
export const sessionNarrativeEntrySchema = z.object({
  /** Milliseconds since the session's first event. Never a wall-clock time. */
  tMs: z.number().int().nonnegative(),
  kind: narrativeEntryKindSchema,
  /** One templated line of prose describing the entry. */
  summary: z.string(),
  refs: narrativeRefsSchema,
  /** How long the entry spans, for the kinds that cover a stretch of time. */
  durationMs: z.number().int().nonnegative().optional(),
  /** How many source events the entry collapses (dwell samples, dip frames, …). */
  count: z.number().int().nonnegative().optional(),
  /** Session totals. Present on the closing `summary` entry only. */
  totals: sessionNarrativeTotalsSchema.optional(),
  /**
   * Whether entries were dropped to honour `maxEntries`. Present on the closing
   * `summary` entry only, so the bound is always visible to whoever reads the
   * last line.
   */
  truncated: z.boolean().optional(),
});

/** One line of the narrative — see {@link sessionNarrativeEntrySchema}. */
export type SessionNarrativeEntry = z.infer<typeof sessionNarrativeEntrySchema>;

/**
 * The bounds and defaults every consumer shares. The collector's querystring
 * schema, the generated tool's input schema and the compaction function all read
 * them from here, so "the default dwell floor" is one number rather than three.
 */
export const NARRATIVE_LIMITS = {
  /** Default dwell floor: below this a mesh is a glance, not attention. */
  defaultMinDwellMs: 1_000,
  /** Largest dwell floor a caller may ask for (one hour). */
  maxMinDwellMs: 3_600_000,
  /** Default FPS floor below which a frame sample counts towards a dip. */
  defaultFpsThreshold: 30,
  /** Largest FPS floor a caller may ask for. */
  maxFpsThreshold: 240,
  /**
   * Consecutive sub-threshold `frame_perf` samples before a dip is reported.
   * Two, so a single unlucky sample (a tab switch, a GC pause) is not a story.
   */
  dipMinSamples: 2,
  /** Default entry cap — the "under 200 lines" bound issue #314 asks for. */
  defaultMaxEntries: 200,
  /** Hard cap: no caller can ask for an unbounded narrative (ADR 0051 §9). */
  maxMaxEntries: 1_000,
  /** Error/diagnostic messages are truncated to this many characters. */
  maxMessageLength: 200,
  /** At most this many custom-event property **keys** are listed per entry. */
  maxCustomPropKeys: 12,
} as const;
