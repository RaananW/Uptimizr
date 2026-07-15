import { describe, expect, it, vi } from "vitest";
import type { CollectorClient } from "@uptimizr/agent-core";
import { registerResources, CAPABILITIES_URI, SCENES_URI } from "../resources.js";

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
  it("registers the capabilities and scenes resources", () => {
    const client = { get: vi.fn() } as unknown as CollectorClient;
    const resources = collect(client);
    expect(resources.get("capabilities")?.uri).toBe(CAPABILITIES_URI);
    expect(resources.get("scenes")?.uri).toBe(SCENES_URI);
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
});
