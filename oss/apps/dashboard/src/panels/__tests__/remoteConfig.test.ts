import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRemotePanelConfig } from "../remoteConfig";

const MANIFEST = "NEXT_PUBLIC_PANELS_MANIFEST_URL";
const ORIGINS = "NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS";

describe("getRemotePanelConfig", () => {
  let prevManifest: string | undefined;
  let prevOrigins: string | undefined;

  beforeEach(() => {
    prevManifest = process.env[MANIFEST];
    prevOrigins = process.env[ORIGINS];
    delete process.env[MANIFEST];
    delete process.env[ORIGINS];
  });

  afterEach(() => {
    if (prevManifest === undefined) delete process.env[MANIFEST];
    else process.env[MANIFEST] = prevManifest;
    if (prevOrigins === undefined) delete process.env[ORIGINS];
    else process.env[ORIGINS] = prevOrigins;
  });

  it("is disabled by default (no manifest configured)", () => {
    const config = getRemotePanelConfig();
    expect(config.enabled).toBe(false);
    expect(config.manifestUrls).toEqual([]);
    expect(config.allowOrigins).toEqual([]);
  });

  it("enables with a single manifest URL", () => {
    process.env[MANIFEST] = "https://example.com/panels.json";
    const config = getRemotePanelConfig();
    expect(config.enabled).toBe(true);
    expect(config.manifestUrls).toEqual(["https://example.com/panels.json"]);
  });

  it("parses a comma-separated list of manifests and trims whitespace", () => {
    process.env[MANIFEST] = " https://a.com/m.json , https://b.com/m.json ";
    const config = getRemotePanelConfig();
    expect(config.manifestUrls).toEqual(["https://a.com/m.json", "https://b.com/m.json"]);
  });

  it("parses an allowlist of origins", () => {
    process.env[MANIFEST] = "https://a.com/m.json";
    process.env[ORIGINS] = "https://a.com, https://cdn.a.com";
    const config = getRemotePanelConfig();
    expect(config.allowOrigins).toEqual(["https://a.com", "https://cdn.a.com"]);
  });

  it("ignores empty entries in the lists", () => {
    process.env[MANIFEST] = ",https://a.com/m.json,,";
    const config = getRemotePanelConfig();
    expect(config.manifestUrls).toEqual(["https://a.com/m.json"]);
  });
});
