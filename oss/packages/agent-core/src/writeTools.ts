import { z } from "zod";
import { LIMITS } from "@uptimizr/schema";
import type { CollectorClient } from "./client.js";

/**
 * The **metadata write tools** (#310, ADR 0051 §5; #315, §7): `annotate`,
 * `define_term`, `save_analysis`, `pin_panel` and `unpin_panel`, plus the four
 * reads that make them usable (`list_annotations`, `list_glossary`,
 * `list_analyses`, `list_panels`).
 *
 * They are a deliberately separate export from `readTools`, not an addition to
 * it, for one reason: ADR 0017's read-only stance must stay **inspectable**. A
 * reader who wants to know whether an integration can change anything looks at
 * which of the two catalogs it registers, and `readTools` remains exactly what
 * its name says.
 *
 * What they can and cannot touch:
 *
 * - They write **metadata only** — notes, definitions, saved questions. No tool
 *   here can write, alter or delete an analytics event; events stay read-only
 *   (ADR 0051 §9) and no ingestion path exists in this package at all.
 * - Every one of them needs an API key holding the `annotate` capability. The
 *   collector enforces that (`403` without it); the MCP server checks it once at
 *   start-up so an agent is never offered a tool its key cannot use.
 * - Every call is recorded in the project's agent audit log, and the stored row
 *   records that an agent — not a person — wrote it.
 *
 * Each definition is pure data plus an `execute` that calls one collector
 * endpoint, so they are unit-testable without a live collector, exactly like the
 * generated read tools.
 */

/** One metadata write (or metadata read) exposed as an agent tool. */
export interface WriteTool {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape the MCP runtime validates arguments against. */
  inputSchema: z.ZodRawShape;
  /** Whether this tool changes stored state (all three writers do; the lists do not). */
  mutates: boolean;
  /** Call the collector with validated arguments and return its JSON. */
  execute: (client: CollectorClient, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Thrown when a write tool is handed a client with no write transport — a
 * read-only `CollectorClient` built by hand, for instance. A clear error beats
 * `client.post is not a function`.
 */
export class WriteNotSupportedError extends Error {
  constructor(method: string) {
    super(
      `This collector client is read-only: it has no \`${method}\` method, so metadata write tools cannot be used with it.`,
    );
    this.name = "WriteNotSupportedError";
  }
}

function requirePost(client: CollectorClient): NonNullable<CollectorClient["post"]> {
  if (!client.post) throw new WriteNotSupportedError("post");
  return client.post.bind(client);
}

function requirePut(client: CollectorClient): NonNullable<CollectorClient["put"]> {
  if (!client.put) throw new WriteNotSupportedError("put");
  return client.put.bind(client);
}

/** Drop `undefined` entries so an optional argument is simply absent on the wire. */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

const targetKind = z
  .enum(["project", "scene", "mesh", "region", "metric", "window"])
  .describe(
    "What the note is about. `scene`/`mesh`/`region`/`metric` need a `targetId`; `window` needs `since`.",
  );

export const annotateTool: WriteTool = {
  name: "annotate",
  title: "Annotate something",
  description:
    "Leave a note on the project, a scene, a mesh, a region, a metric, or a period of time — what changed, what you concluded, what a future reader should know before trusting a number. Notes are shown on dashboard time axes and read back by agents. Use it when you have found something worth remembering, not for scratch state.",
  inputSchema: {
    targetKind,
    targetId: z
      .string()
      .min(1)
      .max(LIMITS.maxAnnotationTargetIdLength)
      .optional()
      .describe("The scene id, mesh name, region id or metric id the note is about."),
    since: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Start of the period the note applies to, epoch milliseconds."),
    until: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("End of the period the note applies to, epoch milliseconds."),
    text: z
      .string()
      .min(1)
      .max(LIMITS.maxAnnotationTextLength)
      .describe("The note itself, in plain words."),
  },
  mutates: true,
  execute: async (client, args) =>
    requirePost(client)(
      "/api/v1/annotations",
      compact({
        targetKind: args.targetKind,
        targetId: args.targetId,
        since: args.since,
        until: args.until,
        text: args.text,
      }),
    ),
};

export const defineTermTool: WriteTool = {
  name: "define_term",
  title: "Define a term",
  description:
    "Record what a name means in this project — a mesh name, a scene id, a custom event, an in-house abbreviation. Writing it down once saves every later reader (and every later agent) from guessing. Defining a term again replaces its meaning.",
  inputSchema: {
    term: z
      .string()
      .min(1)
      .max(LIMITS.maxGlossaryTermLength)
      .describe("The name being defined, exactly as it appears in the data."),
    meaning: z
      .string()
      .min(1)
      .max(LIMITS.maxGlossaryMeaningLength)
      .describe("What it means in this project."),
  },
  mutates: true,
  execute: async (client, args) =>
    requirePut(client)(`/api/v1/glossary/${encodeURIComponent(String(args.term))}`, {
      meaning: args.meaning,
    }),
};

export const saveAnalysisTool: WriteTool = {
  name: "save_analysis",
  title: "Save an analysis",
  description:
    "Store a question worth re-asking together with what you concluded from it: a title someone will recognise in a list, the query that produced the answer, and the finding in words. Use it at the end of an investigation, not for every intermediate query.",
  inputSchema: {
    title: z
      .string()
      .min(1)
      .max(LIMITS.maxSavedAnalysisTitleLength)
      .describe("Short human title, e.g. 'Lobby FPS after the lighting change'."),
    query: z
      .record(z.string(), z.unknown())
      .describe(
        "The question as a JSON object — the endpoint and filters you used. Stored as-is; the collector does not interpret it.",
      ),
    conclusion: z
      .string()
      .max(LIMITS.maxSavedAnalysisConclusionLength)
      .optional()
      .describe("What the numbers showed, and how far to trust it."),
  },
  mutates: true,
  execute: async (client, args) =>
    requirePost(client)(
      "/api/v1/analyses",
      compact({ title: args.title, query: args.query, conclusion: args.conclusion }),
    ),
};

export const listAnnotationsTool: WriteTool = {
  name: "list_annotations",
  title: "Read the project's annotations",
  description:
    "The notes people and agents have already left, newest first. Read them before answering a question about a change or a spike — someone may already have explained it. `since`/`until` select notes whose period overlaps the window.",
  inputSchema: {
    targetKind: targetKind.optional(),
    targetId: z.string().min(1).max(LIMITS.maxAnnotationTargetIdLength).optional(),
    since: z.number().int().nonnegative().optional(),
    until: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(500).optional(),
  },
  mutates: false,
  execute: async (client, args) =>
    client.get("/api/v1/annotations", {
      targetKind: args.targetKind as string | undefined,
      targetId: args.targetId as string | undefined,
      since: args.since as number | undefined,
      until: args.until as number | undefined,
      limit: args.limit as number | undefined,
    }),
};

export const listGlossaryTool: WriteTool = {
  name: "list_glossary",
  title: "Read the project's glossary",
  description:
    "What this project's names mean. Read it before interpreting mesh names, scene ids or custom events — the team's vocabulary is rarely self-explanatory.",
  inputSchema: { limit: z.number().int().positive().max(500).optional() },
  mutates: false,
  execute: async (client, args) =>
    client.get("/api/v1/glossary", { limit: args.limit as number | undefined }),
};

export const listAnalysesTool: WriteTool = {
  name: "list_analyses",
  title: "Read the project's saved analyses",
  description:
    "Questions this project has asked before and what was concluded, newest first. Check here before re-deriving an answer from scratch.",
  inputSchema: { limit: z.number().int().positive().max(500).optional() },
  mutates: false,
  execute: async (client, args) =>
    client.get("/api/v1/analyses", { limit: args.limit as number | undefined }),
};

// --- Declarative panel specs (#315, ADR 0051 §7 / sketch §G.3) -------------
//
// The most durable thing an agent can leave behind: not a note *about* an
// answer, but the question itself, on the dashboard, re-asked every time
// somebody opens it. And still metadata — the spec is a closed document (a
// metric id, a chart name, some column names) that the dashboard renders with
// panels it already ships. No module is loaded and nothing is evaluated, so
// pinning a panel does not widen the dashboard's trust boundary (ADR 0041).

export const pinPanelTool: WriteTool = {
  name: "pin_panel",
  title: "Pin an answer to the dashboard as a panel",
  description:
    "Keep a question on the project's dashboard, where it will be re-asked and redrawn every " +
    "time somebody opens it. Pass the same `query` document you ran with the `query` tool, but " +
    'with `range` set to "inherit" so the panel follows the dashboard\'s own time filter instead ' +
    "of freezing the window you happened to ask in. Pick a `chart` the metric's grain can " +
    "actually support — `line`/`area` need a time-bucketed metric, `heatmap2d` a binned one, " +
    "`world3d` a voxelised one, `stat` a single-record one, `bar` a ranking, `table` anything — " +
    "or the collector refuses the spec and names the charts that would have worked. Put your " +
    "one-line reading in `note`: it becomes the panel's subtitle, and it is the part a person " +
    "reads a week later. Use this when an answer is worth watching, not for a one-off lookup.",
  inputSchema: {
    title: z
      .string()
      .min(1)
      .max(LIMITS.maxPanelSpecTitleLength)
      .describe("What the panel is called in the grid, e.g. 'Meshes people actually touch'."),
    query: z
      .record(z.string(), z.unknown())
      .describe(
        'A `queryV1` document — the same shape the `query` tool takes — with `range` set to "inherit", or to an explicit `{since, until}` to pin one period.',
      ),
    chart: z
      .enum(["stat", "table", "bar", "line", "area", "heatmap2d", "world3d"])
      .describe("How to draw the result. Must suit the metric's grain."),
    encoding: z
      .object({
        x: z.string().max(LIMITS.maxPanelEncodingColumnLength).optional(),
        y: z.string().max(LIMITS.maxPanelEncodingColumnLength).optional(),
        series: z.string().max(LIMITS.maxPanelEncodingColumnLength).optional(),
      })
      .optional()
      .describe(
        "Which result column feeds which channel. Omit to use the metric's own label/axis and measure columns.",
      ),
    span: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe("Grid width: 1 (half) or 2 (full). Defaults to 1."),
    note: z
      .string()
      .max(LIMITS.maxPanelSpecNoteLength)
      .optional()
      .describe("Your one-line reading of the result. Shown as the panel's subtitle."),
  },
  mutates: true,
  execute: async (client, args) =>
    requirePost(client)(
      "/api/v1/panels",
      compact({
        v: 1,
        title: args.title,
        query: args.query,
        chart: args.chart,
        encoding: args.encoding,
        span: args.span,
        note: args.note,
      }),
    ),
};

export const listPanelsTool: WriteTool = {
  name: "list_panels",
  title: "Read the project's pinned panels",
  description:
    "The panels already pinned to this project's dashboard, oldest first — what somebody decided " +
    "was worth watching. Read it before pinning, so you extend the dashboard instead of " +
    "duplicating a panel that is already there, and to learn which questions this team treats as " +
    "important. Each row carries the spec's `id`, which is what `unpin_panel` takes.",
  inputSchema: { limit: z.number().int().positive().max(500).optional() },
  mutates: false,
  execute: async (client, args) =>
    client.get("/api/v1/panels", { limit: args.limit as number | undefined }),
};

export const unpinPanelTool: WriteTool = {
  name: "unpin_panel",
  title: "Remove a pinned panel",
  description:
    "Remove one panel from the project's dashboard by its `id` (from `list_panels`). This " +
    "removes it for **everyone** on the project rather than just the current viewer, so unpin a " +
    "panel that has stopped being useful — never one you have not read first.",
  inputSchema: {
    id: z.string().min(1).max(128).describe("The panel spec's id, as `list_panels` reports it."),
  },
  mutates: true,
  execute: async (client, args) => {
    if (!client.delete) throw new WriteNotSupportedError("delete");
    return client.delete(`/api/v1/panels/${encodeURIComponent(String(args.id))}`);
  },
};

/**
 * The metadata tool catalog. Registered **only** when the calling key holds the
 * `annotate` capability — including the read tools, which are listed here
 * rather than in `readTools` so the whole metadata surface appears and
 * disappears as one coherent feature.
 */
export const writeTools: readonly WriteTool[] = [
  annotateTool,
  defineTermTool,
  saveAnalysisTool,
  pinPanelTool,
  unpinPanelTool,
  listAnnotationsTool,
  listGlossaryTool,
  listAnalysesTool,
  listPanelsTool,
];

/** The tools that actually change stored state. */
export const mutatingWriteTools: readonly WriteTool[] = writeTools.filter((tool) => tool.mutates);
