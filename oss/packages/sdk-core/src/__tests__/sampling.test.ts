import { describe, expect, it } from "vitest";
import { resolveCadence } from "../sampling.js";

describe("resolveCadence (ADR 0012)", () => {
  it("falls back to the connector default when the rate is undefined", () => {
    expect(resolveCadence(undefined, 1000)).toEqual({ mode: "interval", ms: 1000 });
  });

  it("treats 0 (and negatives) as off", () => {
    expect(resolveCadence(0, 1000)).toEqual({ mode: "off" });
    expect(resolveCadence(-5, 1000)).toEqual({ mode: "off" });
  });

  it("passes through 'frame' for per-tick capture", () => {
    expect(resolveCadence("frame", 1000)).toEqual({ mode: "frame" });
  });

  it("converts a Hz rate into an interval in milliseconds", () => {
    expect(resolveCadence(10, 1000)).toEqual({ mode: "interval", ms: 100 });
    expect(resolveCadence(60, 1000)).toEqual({ mode: "interval", ms: 1000 / 60 });
  });
});
