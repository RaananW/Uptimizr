import { describe, expect, it, vi } from "vitest";
import type { PanelDefinition } from "../panels/contract";
import { PANEL_CONTRACT_VERSION } from "../panels/contract";
import {
  fetchPanelManifest,
  isContractCompatible,
  isPanelDefinition,
  isPanelManifest,
  loadRemotePanels,
  mergePanels,
  type ModuleImporter,
  type PanelManifest,
} from "../panels/remote";

const validPanel: PanelDefinition<unknown> = {
  id: "remote-demo",
  title: "Remote demo",
  render: () => null,
};

function manifest(overrides: Partial<PanelManifest["panels"][number]> = {}): PanelManifest {
  return {
    version: 1,
    panels: [{ url: "https://panels.example.com/demo.js", contract: PANEL_CONTRACT_VERSION, ...overrides }],
  };
}

describe("isPanelDefinition", () => {
  it("accepts a minimal valid definition", () => {
    expect(isPanelDefinition(validPanel)).toBe(true);
  });

  it.each([
    ["null", null],
    ["missing id", { title: "x", render: () => null }],
    ["empty id", { id: "", title: "x", render: () => null }],
    ["missing render", { id: "x", title: "x" }],
    ["non-function load", { id: "x", title: "x", render: () => null, load: 5 }],
    ["bad span", { id: "x", title: "x", render: () => null, span: 3 }],
    ["bad surfaces", { id: "x", title: "x", render: () => null, surfaces: "overview" }],
  ])("rejects %s", (_label, value) => {
    expect(isPanelDefinition(value)).toBe(false);
  });
});

describe("isContractCompatible", () => {
  it("matches the running contract version", () => {
    expect(isContractCompatible(PANEL_CONTRACT_VERSION)).toBe(true);
    expect(isContractCompatible(PANEL_CONTRACT_VERSION + 1)).toBe(false);
    expect(isContractCompatible("1")).toBe(false);
  });
});

describe("isPanelManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(isPanelManifest(manifest())).toBe(true);
  });

  it.each([
    ["non-object", 5],
    ["missing version", { panels: [] }],
    ["panels not array", { version: 1, panels: {} }],
    ["entry missing url", { version: 1, panels: [{ contract: 1 }] }],
    ["entry bad contract", { version: 1, panels: [{ url: "x", contract: "1" }] }],
  ])("rejects %s", (_label, value) => {
    expect(isPanelManifest(value)).toBe(false);
  });
});

describe("loadRemotePanels", () => {
  it("loads a valid default-exported panel", async () => {
    const importModule: ModuleImporter = vi.fn(async () => ({ default: validPanel }));
    const { panels, errors } = await loadRemotePanels(manifest(), { importModule });
    expect(errors).toEqual([]);
    expect(panels).toEqual([validPanel]);
    expect(importModule).toHaveBeenCalledWith("https://panels.example.com/demo.js");
  });

  it("reads a named export when requested", async () => {
    const importModule: ModuleImporter = async () => ({ myPanel: validPanel });
    const { panels } = await loadRemotePanels(manifest({ export: "myPanel" }), { importModule });
    expect(panels).toEqual([validPanel]);
  });

  it("falls back to a `panel` export when no default", async () => {
    const importModule: ModuleImporter = async () => ({ panel: validPanel });
    const { panels } = await loadRemotePanels(manifest(), { importModule });
    expect(panels).toEqual([validPanel]);
  });

  it("rejects an incompatible contract version", async () => {
    const importModule = vi.fn();
    const { panels, errors } = await loadRemotePanels(manifest({ contract: 99 }), {
      importModule,
    });
    expect(panels).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "incompatible" });
    expect(importModule).not.toHaveBeenCalled();
  });

  it("blocks a module URL whose origin is not allowlisted", async () => {
    const importModule = vi.fn();
    const { errors } = await loadRemotePanels(manifest(), {
      importModule,
      allowOrigins: ["https://trusted.example.com"],
    });
    expect(errors[0]).toMatchObject({ code: "origin-blocked" });
    expect(importModule).not.toHaveBeenCalled();
  });

  it("allows a module URL whose origin is allowlisted", async () => {
    const importModule: ModuleImporter = async () => ({ default: validPanel });
    const { panels, errors } = await loadRemotePanels(manifest(), {
      importModule,
      allowOrigins: ["https://panels.example.com"],
    });
    expect(errors).toEqual([]);
    expect(panels).toEqual([validPanel]);
  });

  it("surfaces an import failure as a per-entry error", async () => {
    const importModule: ModuleImporter = async () => {
      throw new Error("network down");
    };
    const { panels, errors } = await loadRemotePanels(manifest(), { importModule });
    expect(panels).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "import-failed", message: "network down" });
  });

  it("reports a missing export", async () => {
    const importModule: ModuleImporter = async () => ({});
    const { errors } = await loadRemotePanels(manifest({ export: "nope" }), { importModule });
    expect(errors[0]).toMatchObject({ code: "export-missing" });
  });

  it("reports an invalid panel export", async () => {
    const importModule: ModuleImporter = async () => ({ default: { id: 1 } });
    const { errors } = await loadRemotePanels(manifest(), { importModule });
    expect(errors[0]).toMatchObject({ code: "invalid-panel" });
  });

  it("isolates failures: one bad entry does not block the others", async () => {
    const good: PanelDefinition<unknown> = { ...validPanel, id: "good" };
    const multi: PanelManifest = {
      version: 1,
      panels: [
        { url: "https://panels.example.com/bad.js", contract: PANEL_CONTRACT_VERSION },
        { url: "https://panels.example.com/good.js", contract: PANEL_CONTRACT_VERSION },
      ],
    };
    const importModule: ModuleImporter = async (url) => {
      if (url.endsWith("bad.js")) throw new Error("boom");
      return { default: good };
    };
    const { panels, errors } = await loadRemotePanels(multi, { importModule });
    expect(panels).toEqual([good]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "import-failed" });
  });
});

describe("fetchPanelManifest", () => {
  it("returns a parsed manifest on success", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(manifest()), { status: 200 }));
    const result = await fetchPanelManifest("https://example.com/m.json", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ version: 1 });
  });

  it("returns a manifest-fetch error on HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const result = await fetchPanelManifest("https://example.com/m.json", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ code: "manifest-fetch", message: "HTTP 404" });
  });

  it("returns a manifest-fetch error when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await fetchPanelManifest("https://example.com/m.json", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ code: "manifest-fetch", message: "offline" });
  });

  it("returns a manifest-invalid error on a bad shape", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    const result = await fetchPanelManifest("https://example.com/m.json", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ code: "manifest-invalid" });
  });
});

describe("mergePanels", () => {
  it("appends remote panels after built-ins", () => {
    const a: PanelDefinition<unknown> = { ...validPanel, id: "a" };
    const b: PanelDefinition<unknown> = { ...validPanel, id: "b" };
    const { panels, errors } = mergePanels([a], [b]);
    expect(panels.map((p) => p.id)).toEqual(["a", "b"]);
    expect(errors).toEqual([]);
  });

  it("keeps the built-in on an id collision and reports the duplicate", () => {
    const builtin: PanelDefinition<unknown> = { ...validPanel, id: "dup", title: "builtin" };
    const remote: PanelDefinition<unknown> = { ...validPanel, id: "dup", title: "remote" };
    const { panels, errors } = mergePanels([builtin], [remote]);
    expect(panels).toHaveLength(1);
    expect(panels[0].title).toBe("builtin");
    expect(errors[0]).toMatchObject({ code: "invalid-panel", source: "dup" });
  });
});
