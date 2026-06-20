import { describe, expect, it } from "vitest";

import { xrCollector } from "../index.js";
import { xrCollector as threeXrCollector } from "@uptimizr/three";

// The WebXR controller/gaze collector is owned by `@uptimizr/three` (A-Frame renders
// three, so there is a single implementation). A-Frame only re-exports it — these
// guards assert there is no second, drifting copy. The behavioural coverage lives in
// `@uptimizr/three`'s `xr.test.ts`.
describe("@uptimizr/aframe XR re-export", () => {
  it("re-exports the shared three XR collector (no duplicated source)", () => {
    expect(xrCollector).toBe(threeXrCollector);
  });

  it("produces a collector named three-xr", () => {
    const collector = xrCollector({ renderer: { xr: undefined } });
    expect(collector.name).toBe("three-xr");
  });
});
