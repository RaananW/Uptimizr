import { describe, expect, it } from "vitest";
import {
  annotationSchema,
  glossaryEntrySchema,
  savedAnalysisSchema,
  LIMITS,
  anyEventSchema,
} from "../index.js";

/**
 * Project metadata contracts (ADR 0051 §5 / sketch §E.2). These are config
 * shapes, not events — the last test pins that promise.
 */

describe("annotationSchema", () => {
  it("accepts a standing project note with no time range", () => {
    const parsed = annotationSchema.parse({ targetKind: "project", text: "v2.1 shipped" });
    expect(parsed.targetKind).toBe("project");
    expect(parsed.since).toBeUndefined();
  });

  it("accepts a mesh note with a target and a period", () => {
    const parsed = annotationSchema.parse({
      targetKind: "mesh",
      targetId: "checkout_counter",
      since: 1_700_000_000_000,
      until: 1_700_003_600_000,
      text: "dead clicks here after the collider change",
    });
    expect(parsed.targetId).toBe("checkout_counter");
  });

  it("requires a targetId for scene, mesh, region and metric notes", () => {
    for (const targetKind of ["scene", "mesh", "region", "metric"] as const) {
      expect(annotationSchema.safeParse({ targetKind, text: "note" }).success).toBe(false);
    }
  });

  it("requires a since timestamp on a window note", () => {
    expect(annotationSchema.safeParse({ targetKind: "window", text: "outage" }).success).toBe(
      false,
    );
    expect(
      annotationSchema.safeParse({ targetKind: "window", since: 1, text: "outage" }).success,
    ).toBe(true);
  });

  it("rejects an inverted range", () => {
    const result = annotationSchema.safeParse({
      targetKind: "window",
      since: 2_000,
      until: 1_000,
      text: "backwards",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty and over-long text", () => {
    expect(annotationSchema.safeParse({ targetKind: "project", text: "" }).success).toBe(false);
    expect(
      annotationSchema.safeParse({
        targetKind: "project",
        text: "x".repeat(LIMITS.maxAnnotationTextLength + 1),
      }).success,
    ).toBe(false);
    expect(
      annotationSchema.safeParse({
        targetKind: "project",
        text: "x".repeat(LIMITS.maxAnnotationTextLength),
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown target kind", () => {
    expect(annotationSchema.safeParse({ targetKind: "session", text: "no" }).success).toBe(false);
  });
});

describe("glossaryEntrySchema", () => {
  it("accepts a multi-word term", () => {
    const parsed = glossaryEntrySchema.parse({
      term: "checkout counter",
      meaning: "the till mesh cluster by the exit",
    });
    expect(parsed.term).toBe("checkout counter");
  });

  it("rejects a term carrying a slash or a control character", () => {
    expect(glossaryEntrySchema.safeParse({ term: "a/b", meaning: "x" }).success).toBe(false);
    expect(glossaryEntrySchema.safeParse({ term: "a\nb", meaning: "x" }).success).toBe(false);
  });

  it("rejects untrimmed, empty and over-long terms and meanings", () => {
    expect(glossaryEntrySchema.safeParse({ term: " padded ", meaning: "x" }).success).toBe(false);
    expect(glossaryEntrySchema.safeParse({ term: "", meaning: "x" }).success).toBe(false);
    expect(
      glossaryEntrySchema.safeParse({
        term: "x".repeat(LIMITS.maxGlossaryTermLength + 1),
        meaning: "x",
      }).success,
    ).toBe(false);
    expect(
      glossaryEntrySchema.safeParse({
        term: "t",
        meaning: "x".repeat(LIMITS.maxGlossaryMeaningLength + 1),
      }).success,
    ).toBe(false);
  });
});

describe("savedAnalysisSchema", () => {
  it("accepts a title, an opaque query document and a conclusion", () => {
    const parsed = savedAnalysisSchema.parse({
      title: "Lobby FPS after the lighting change",
      query: { metric: "perf_summary", scene: "lobby" },
      conclusion: "p50 fell from 58 to 41 on integrated GPUs.",
    });
    expect(parsed.query.metric).toBe("perf_summary");
  });

  it("accepts an analysis with no conclusion yet", () => {
    expect(savedAnalysisSchema.safeParse({ title: "watch this", query: {} }).success).toBe(true);
  });

  it("rejects a non-object query", () => {
    expect(savedAnalysisSchema.safeParse({ title: "t", query: [] }).success).toBe(false);
    expect(savedAnalysisSchema.safeParse({ title: "t", query: "select *" }).success).toBe(false);
  });

  it("rejects a query document beyond the serialized bound", () => {
    const query = { blob: "x".repeat(LIMITS.maxSavedAnalysisQueryLength) };
    expect(savedAnalysisSchema.safeParse({ title: "t", query }).success).toBe(false);
  });

  it("rejects an over-long title and conclusion", () => {
    expect(
      savedAnalysisSchema.safeParse({
        title: "x".repeat(LIMITS.maxSavedAnalysisTitleLength + 1),
        query: {},
      }).success,
    ).toBe(false);
    expect(
      savedAnalysisSchema.safeParse({
        title: "t",
        query: {},
        conclusion: "x".repeat(LIMITS.maxSavedAnalysisConclusionLength + 1),
      }).success,
    ).toBe(false);
  });
});

describe("metadata is not an event", () => {
  it("is rejected by the event union, so it can never reach the ingest path", () => {
    const annotation = { targetKind: "project", text: "v2.1 shipped" };
    expect(anyEventSchema.safeParse(annotation).success).toBe(false);
    expect(anyEventSchema.safeParse({ type: "annotation", ...annotation }).success).toBe(false);
  });
});
