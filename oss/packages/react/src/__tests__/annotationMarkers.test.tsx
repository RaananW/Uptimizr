import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AnnotationRow, TimeseriesBucket } from "../api";
import { VolumeTimeseriesView } from "../catalog/views/VolumeTimeseries";

/**
 * Annotation markers on the event-volume time axis (#310, ADR 0051 §5).
 *
 * The markers are DOM elements rather than canvas drawing, so each carries a
 * real tooltip — and so this can be asserted without reading pixels. happy-dom
 * has no canvas 2D context; the view already tolerates that (`getContext`
 * returns null and the drawing pass is skipped), which is exactly what lets the
 * overlay be tested on its own.
 */

const HOUR = 3_600_000;
const START = 1_700_000_000_000;

const buckets: TimeseriesBucket[] = [
  { bucket: START, events: 10 },
  { bucket: START + HOUR, events: 20 },
  { bucket: START + 2 * HOUR, events: 5 },
];

function annotation(overrides: Partial<AnnotationRow>): AnnotationRow {
  return {
    id: "an_1",
    projectId: "p1",
    targetKind: "window",
    targetId: null,
    since: new Date(START + HOUR).toISOString(),
    until: null,
    text: "v2.1 shipped",
    authorKind: "user",
    authorKeyId: "k1",
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderView(annotations: AnnotationRow[]) {
  return render(
    <VolumeTimeseriesView
      buckets={buckets}
      intervalMs={HOUR}
      onBrush={() => {}}
      annotations={annotations}
    />,
  );
}

describe("annotation markers", () => {
  it("renders nothing when there are no annotations", () => {
    renderView([]);
    expect(screen.queryByLabelText("Annotations")).toBeNull();
  });

  it("marks an annotation inside the plotted span and shows its text as the tooltip", () => {
    renderView([annotation({})]);
    const list = screen.getByLabelText("Annotations");
    expect(list.querySelectorAll("[data-role='annotation-marker']")).toHaveLength(1);
    expect(screen.getByLabelText("v2.1 shipped")).toBeTruthy();
    expect(screen.getByLabelText("v2.1 shipped").getAttribute("title")).toBe("v2.1 shipped");
  });

  it("skips a standing note with no timestamp — it has no place on a time axis", () => {
    renderView([annotation({ targetKind: "project", since: null })]);
    expect(screen.queryByLabelText("Annotations")).toBeNull();
  });

  it("skips an annotation whose whole period is outside the plotted window", () => {
    renderView([annotation({ since: new Date(START - 10 * HOUR).toISOString() })]);
    expect(screen.queryByLabelText("Annotations")).toBeNull();

    cleanup();
    renderView([annotation({ since: new Date(START + 10 * HOUR).toISOString() })]);
    expect(screen.queryByLabelText("Annotations")).toBeNull();
  });

  it("clamps a note that starts before the strip but overlaps it to the left edge", () => {
    // The strip spans the buckets that have data, which is narrower than the
    // range the user asked for — a note about that whole window still belongs
    // on the axis.
    renderView([
      annotation({
        since: new Date(START - 5 * HOUR).toISOString(),
        until: new Date(START + HOUR).toISOString(),
        text: "the outage",
      }),
    ]);
    const marker = screen
      .getByLabelText("Annotations")
      .querySelector<HTMLElement>("[data-role='annotation-marker']");
    expect(marker).toBeTruthy();
    // 0% along the axis: pinned to the strip's start, not off-canvas.
    expect(marker!.style.left).toContain("* 0)");
  });

  it("places each marker at its own position along the axis", () => {
    renderView([
      annotation({ id: "a", since: new Date(START).toISOString(), text: "start" }),
      annotation({ id: "b", since: new Date(START + 2 * HOUR).toISOString(), text: "later" }),
    ]);
    const markers = Array.from(
      screen
        .getByLabelText("Annotations")
        .querySelectorAll<HTMLElement>("[data-role='annotation-marker']"),
    );
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.dataset.annotationId)).toEqual(["a", "b"]);
    expect(markers[0]!.style.left).not.toBe(markers[1]!.style.left);
  });

  it("does not render markers when the strip has no data to place them against", () => {
    render(
      <VolumeTimeseriesView
        buckets={[]}
        intervalMs={HOUR}
        onBrush={() => {}}
        annotations={[annotation({})]}
      />,
    );
    expect(screen.queryByLabelText("Annotations")).toBeNull();
  });
});
