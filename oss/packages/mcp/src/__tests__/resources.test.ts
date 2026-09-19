import { describe, expect, it, vi } from "vitest";
import { AGENT_SKILLS, type CollectorClient } from "@uptimizr/agent-core";
import {
  registerResources,
  CAPABILITIES_URI,
  CONTEXT_URI,
  SCENES_URI,
  SKILLS_URI,
} from "../resources.js";

type ReadCb = (
  uri: URL,
) => Promise<{ contents: { uri: string; mimeType?: string; text: string }[] }>;

/** Capture the resources a `registerResources` call registers. */
function collect(client: CollectorClient) {
  const resources = new Map<string, { uri: string; config: { mimeType?: string }; cb: ReadCb }>();
  const server = {
    registerResource: (name: string, uri: string, config: { mimeType?: string }, cb: ReadCb) => {
      resources.set(name, { uri, config, cb });
    },
  };
  registerResources(server as never, client);
  return resources;
}

describe("registerResources", () => {
  it("registers the capabilities, context, scenes and skills resources", () => {
    const client = { get: vi.fn() } as unknown as CollectorClient;
    const resources = collect(client);
    expect(resources.get("capabilities")?.uri).toBe(CAPABILITIES_URI);
    expect(resources.get("context")?.uri).toBe(CONTEXT_URI);
    expect(resources.get("scenes")?.uri).toBe(SCENES_URI);
    expect(resources.get("skills")?.uri).toBe(SKILLS_URI);
  });

  it("tells the agent, in the capabilities notes, to read the context first", async () => {
    const resources = collect({ get: vi.fn() } as unknown as CollectorClient);
    const result = await resources.get("capabilities")!.cb(new URL(CAPABILITIES_URI));
    const parsed = JSON.parse(result.contents[0]!.text) as { notes: string[] };
    expect(parsed.notes[0]).toContain("uptimizr://context");
    expect(parsed.notes[0]).toContain("FIRST");
  });

  it("serves the live project context via the read-only collector client", async () => {
    const document = { project: { id: "p1", store: "duckdb" }, scenes: [{ id: "lobby" }] };
    const get = vi.fn().mockResolvedValue(document);
    const resources = collect({ get } as unknown as CollectorClient);
    const context = resources.get("context")!;
    const result = await context.cb(new URL(CONTEXT_URI));
    expect(get).toHaveBeenCalledWith("api/v1/context", {});
    expect(context.config.mimeType).toBe("application/json");
    expect(JSON.parse(result.contents[0]!.text)).toEqual(document);
  });

  it("serves the capabilities descriptor as JSON without touching the collector", async () => {
    const get = vi.fn();
    const resources = collect({ get } as unknown as CollectorClient);
    const cap = resources.get("capabilities")!;
    const result = await cap.cb(new URL(CAPABILITIES_URI));
    expect(get).not.toHaveBeenCalled();
    expect(cap.config.mimeType).toBe("application/json");
    const parsed = JSON.parse(result.contents[0]!.text);
    expect(parsed.readOnly).toBe(true);
    expect(parsed.tools.map((t: { name: string }) => t.name)).toContain("funnel");
  });

  it("serves live scenes via the read-only collector client", async () => {
    const get = vi.fn().mockResolvedValue([{ scene: "lobby" }]);
    const resources = collect({ get } as unknown as CollectorClient);
    const result = await resources.get("scenes")!.cb(new URL(SCENES_URI));
    expect(get).toHaveBeenCalledWith("api/v1/scenes", {});
    expect(JSON.parse(result.contents[0]!.text)).toEqual([{ scene: "lobby" }]);
  });

  it("lists the packaged skills without calling the collector (#316)", async () => {
    const get = vi.fn();
    const resources = collect({ get } as unknown as CollectorClient);
    const skills = resources.get("skills")!;
    const result = await skills.cb(new URL(SKILLS_URI));
    expect(get).not.toHaveBeenCalled();
    expect(skills.config.mimeType).toBe("application/json");

    const parsed = JSON.parse(result.contents[0]!.text) as {
      skills: { name: string; tools: string[]; capabilities: string[]; file: string }[];
    };
    expect(parsed.skills.map((skill) => skill.name)).toEqual(
      AGENT_SKILLS.map((skill) => skill.name),
    );
    for (const skill of parsed.skills) {
      expect(skill.description).toContain("USE FOR:");
      expect(skill.capabilities).toContain("query");
      expect(skill.tools.length).toBeGreaterThan(0);
      // The packaged path, so a client that has the tarball can open the method
      // itself rather than only the summary.
      expect(skill.file).toMatch(/^skills\/[a-z-]+\/SKILL\.md$/);
    }
  });

  it("never puts an unrendered template placeholder in front of a model", async () => {
    const resources = collect({ get: vi.fn() } as unknown as CollectorClient);
    const result = await resources.get("skills")!.cb(new URL(SKILLS_URI));
    expect(result.contents[0]!.text).not.toContain("{{");
  });
});
