import { describe, expect, it } from "vitest";
import {
  LIMITS,
  anyEventSchema,
  sceneRegionSchema,
  sceneRegionsSchema,
  type SceneRegion,
} from "../index.js";

function validRegion(overrides: Partial<SceneRegion> = {}): SceneRegion {
  return {
    id: "checkout-counter",
    label: "Checkout counter",
    bounds: [-1, 0, -1, 1, 2.5, 1],
    ...overrides,
  };
}

describe("sceneRegionSchema", () => {
  it("accepts a well-formed region", () => {
    expect(sceneRegionSchema.parse(validRegion())).toMatchObject({
      id: "checkout-counter",
      label: "Checkout counter",
    });
  });

  it("accepts an optional description", () => {
    const parsed = sceneRegionSchema.parse(validRegion({ description: "Where visitors pay." }));
    expect(parsed.description).toBe("Where visitors pay.");
  });

  it("accepts a degenerate (zero-volume) box — a plane or a point is a valid region", () => {
    expect(() =>
      sceneRegionSchema.parse(validRegion({ bounds: [1, 1, 1, 1, 1, 1] })),
    ).not.toThrow();
  });

  it("requires a 6-tuple AABB", () => {
    expect(() => sceneRegionSchema.parse(validRegion({ bounds: [0, 0, 0] as never }))).toThrow();
  });

  it("rejects bounds whose max is below min on an axis", () => {
    expect(() => sceneRegionSchema.parse(validRegion({ bounds: [0, 0, 0, -1, 1, 1] }))).toThrow();
  });

  it("rejects a non-finite bound", () => {
    expect(() =>
      sceneRegionSchema.parse(validRegion({ bounds: [0, 0, 0, Number.NaN, 1, 1] })),
    ).toThrow();
  });

  it("rejects a PII-ish high-cardinality region id", () => {
    expect(() => sceneRegionSchema.parse(validRegion({ id: "user@example.com" }))).toThrow();
  });

  it("rejects an empty region id", () => {
    expect(() => sceneRegionSchema.parse(validRegion({ id: "" }))).toThrow();
  });

  it("rejects an empty label", () => {
    expect(() => sceneRegionSchema.parse(validRegion({ label: "" }))).toThrow();
  });

  it("rejects an over-length label", () => {
    const label = "x".repeat(LIMITS.maxSceneRegionLabelLength + 1);
    expect(() => sceneRegionSchema.parse(validRegion({ label }))).toThrow();
  });

  it("rejects an over-length description", () => {
    const description = "x".repeat(LIMITS.maxSceneRegionDescriptionLength + 1);
    expect(() => sceneRegionSchema.parse(validRegion({ description }))).toThrow();
  });
});

describe("sceneRegionsSchema", () => {
  it("accepts an empty set — a scene may declare no regions", () => {
    expect(sceneRegionsSchema.parse([])).toEqual([]);
  });

  it("accepts overlapping regions (membership is all containing boxes)", () => {
    const regions = [
      validRegion({ id: "hall", bounds: [-10, 0, -10, 10, 5, 10] }),
      validRegion({ id: "desk", bounds: [-1, 0, -1, 1, 2, 1] }),
    ];
    expect(sceneRegionsSchema.parse(regions)).toHaveLength(2);
  });

  it("rejects duplicate region ids within a scene", () => {
    expect(() => sceneRegionsSchema.parse([validRegion(), validRegion()])).toThrow();
  });

  it("rejects more regions than the cap", () => {
    const regions = Array.from({ length: LIMITS.maxSceneRegions + 1 }, (_, i) =>
      validRegion({ id: `r${i}` }),
    );
    expect(() => sceneRegionsSchema.parse(regions)).toThrow();
  });
});

describe("regions are config, not events", () => {
  it("is not part of the analytics event union", () => {
    // Golden rule 2 ("events live once"): a region is scene metadata authored
    // out-of-band, never something the keyless ingest path accepts.
    expect(() => anyEventSchema.parse({ type: "scene_region", ...validRegion() })).toThrow();
  });
});
