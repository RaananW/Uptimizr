import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { version } from "../version.js";

describe("version", () => {
  it("is the version in package.json", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(version).toBe(manifest.version);
  });
});
