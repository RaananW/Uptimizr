import { describe, expect, it } from "vitest";
import { readMcpConfig } from "../config.js";

describe("readMcpConfig", () => {
  it("reads a valid collector url and api key", () => {
    const config = readMcpConfig({
      UPTIMIZR_COLLECTOR_URL: "https://collect.example.com",
      UPTIMIZR_API_KEY: "utk_example",
    } as NodeJS.ProcessEnv);
    expect(config).toEqual({
      collectorUrl: "https://collect.example.com",
      apiKey: "utk_example",
    });
  });

  it("rejects a missing api key", () => {
    expect(() =>
      readMcpConfig({
        UPTIMIZR_COLLECTOR_URL: "https://collect.example.com",
      } as NodeJS.ProcessEnv),
    ).toThrow(/UPTIMIZR_API_KEY/);
  });

  it("rejects a malformed collector url", () => {
    expect(() =>
      readMcpConfig({
        UPTIMIZR_COLLECTOR_URL: "not-a-url",
        UPTIMIZR_API_KEY: "utk_example",
      } as NodeJS.ProcessEnv),
    ).toThrow(/UPTIMIZR_COLLECTOR_URL/);
  });
});
