import { z } from "zod";
import { LIMITS } from "@uptimizr/schema";
import type { CollectorClient } from "./client.js";

/**
 * The **metadata write tools** (#310, ADR 0051 §5): `annotate`, `define_term`
 * and `save_analysis`, plus the three reads that make them usable
 * (`list_annotations`, `list_glossary`, `list_analyses`).
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

/**
 * The metadata tool catalog. Registered **only** when the calling key holds the
 * `annotate` capability — including the three read tools, which are listed here
 * rather than in `readTools` so the whole metadata surface appears and
 * disappears as one coherent feature.
 */
export const writeTools: readonly WriteTool[] = [
  annotateTool,
  defineTermTool,
  saveAnalysisTool,
  listAnnotationsTool,
  listGlossaryTool,
  listAnalysesTool,
];

/** The three tools that actually change stored state. */
export const mutatingWriteTools: readonly WriteTool[] = writeTools.filter((tool) => tool.mutates);
