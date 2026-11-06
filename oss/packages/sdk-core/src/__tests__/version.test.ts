import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../version.js";

describe("SDK_VERSION", () => {
  it("is the version in package.json, so events report the SDK that sent them", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(SDK_VERSION).toBe(manifest.version);
  });
});
