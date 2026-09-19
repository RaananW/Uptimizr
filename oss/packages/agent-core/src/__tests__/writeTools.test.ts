import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CollectorClient } from "../client.js";
import { readTools } from "../tools.js";
import { WriteNotSupportedError, mutatingWriteTools, writeTools } from "../writeTools.js";

/**
 * The metadata write tools as pure definitions (#310) — no MCP runtime, no live
 * collector. What matters here is the *catalog's* promises: it is separate from
 * `readTools`, it only writes metadata, and each tool's arguments are bounded.
 */

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function recorder(): { client: CollectorClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      get: async (path) => {
        calls.push({ method: "GET", path });
        return [];
      },
      post: async (path, body) => {
        calls.push({ method: "POST", path, body });
        return {};
      },
      put: async (path, body) => {
        calls.push({ method: "PUT", path, body });
        return {};
      },
      delete: async (path) => {
        calls.push({ method: "DELETE", path });
        return null;
      },
    },
  };
}

describe("the catalog", () => {
  it("is separate from the read catalog, so the read-only stance stays inspectable", () => {
    const readNames = new Set(readTools.map((tool) => tool.name));
    for (const tool of writeTools) expect(readNames.has(tool.name)).toBe(false);
  });

  it("names the three writers and the three readers", () => {
    expect(writeTools.map((tool) => tool.name)).toEqual([
      "annotate",
      "define_term",
      "save_analysis",
      "list_annotations",
      "list_glossary",
      "list_analyses",
    ]);
    expect(mutatingWriteTools.map((tool) => tool.name)).toEqual([
      "annotate",
      "define_term",
      "save_analysis",
    ]);
  });

  it("gives every tool a title, a description and a described input schema", () => {
    for (const tool of writeTools) {
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(Object.keys(tool.inputSchema).length, tool.name).toBeGreaterThan(0);
    }
  });
});

describe("argument bounds", () => {
  it("rejects an over-long annotation and an empty one", () => {
    const shape = z.object(writeTools[0]!.inputSchema);
    expect(shape.safeParse({ targetKind: "project", text: "" }).success).toBe(false);
    expect(shape.safeParse({ targetKind: "project", text: "x".repeat(2001) }).success).toBe(false);
    expect(shape.safeParse({ targetKind: "project", text: "ok" }).success).toBe(true);
  });

  it("rejects an unknown annotation target kind", () => {
    const shape = z.object(writeTools[0]!.inputSchema);
    expect(shape.safeParse({ targetKind: "visitor", text: "no" }).success).toBe(false);
  });

  it("bounds the glossary term and meaning", () => {
    const shape = z.object(writeTools[1]!.inputSchema);
    expect(shape.safeParse({ term: "x".repeat(65), meaning: "m" }).success).toBe(false);
    expect(shape.safeParse({ term: "t", meaning: "x".repeat(501) }).success).toBe(false);
  });
});

describe("what each tool sends", () => {
  it("omits optional fields the caller left out", async () => {
    const { client, calls } = recorder();
    await writeTools[0]!.execute(client, { targetKind: "project", text: "note" });
    expect(calls[0]!.body).toEqual({ targetKind: "project", text: "note" });
  });

  it("encodes a glossary term into the path", async () => {
    const { client, calls } = recorder();
    await writeTools[1]!.execute(client, { term: "a b/c", meaning: "m" });
    expect(calls[0]!.path).toBe("/api/v1/glossary/a%20b%2Fc");
  });

  it("uses GET for the three metadata reads", async () => {
    const { client, calls } = recorder();
    for (const tool of writeTools.filter((t) => !t.mutates)) {
      await tool.execute(client, {});
    }
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("a read-only client", () => {
  it("is refused with an explanation rather than a TypeError", async () => {
    const readOnly: CollectorClient = { get: async () => [] };
    for (const tool of mutatingWriteTools) {
      await expect(
        tool.execute(readOnly, {
          targetKind: "project",
          text: "x",
          term: "t",
          meaning: "m",
          title: "t",
          query: {},
        }),
      ).rejects.toBeInstanceOf(WriteNotSupportedError);
    }
  });
});
