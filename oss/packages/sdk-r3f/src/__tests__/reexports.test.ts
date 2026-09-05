import { describe, expect, it } from "vitest";
import * as three from "@uptimizr/three";

import { createGazeRaycaster, createSceneRaycaster, createXrRaycaster } from "../index.js";

// R3F hosts depend on `@uptimizr/r3f` only, so the raycast probes they need for
// pointer / gaze / WebXR hit resolution are re-exported verbatim from the three
// connector — these guards assert there is no second, drifting copy.
describe("@uptimizr/r3f raycast re-exports", () => {
  it("re-exports the three connector's probe factories", () => {
    expect(createSceneRaycaster).toBe(three.createSceneRaycaster);
    expect(createGazeRaycaster).toBe(three.createGazeRaycaster);
    expect(createXrRaycaster).toBe(three.createXrRaycaster);
  });
});
