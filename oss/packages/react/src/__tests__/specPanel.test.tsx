import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { PanelChartKind, PanelSpecV1 } from "@uptimizr/schema";
import { CollectorApi, type PanelSpecRow } from "../api";
import type { PanelContext, PanelDataContext } from "../panels/contract";
import {
  isSpecPanelId,
  loadSpecPanels,
  resolveEncoding,
  specIdFromPanelId,
  specPanel,
  specPanelId,
  specQuery,
} from "../panels/spec";

/**
 * Declarative panel specs, rendered (#315, ADR 0051 §7 / sketch §G.3).
 *
 * What these tests hold the implementation to:
 *
 * - every chart kind draws something recognisable from fixture rows;
 * - `range: "inherit"` becomes the host's active window on every load, so a
 *   pinned panel follows the filter bar instead of freezing;
 * - a spec that cannot be drawn says so **inline**, and never throws;
 * - `loadSpecPanels` skips a bad spec with a `RemotePanelError`-shaped entry, so
 *   one malformed row can never empty somebody's dashboard;
 * - and a spec panel is an ordinary `PanelDefinition`, so ADR 0039's
 *   hide/settings persistence works on it by id like any other panel.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RANGE = { since: 1_757_000_000_000, until: 1_757_600_000_000 };

function spec(overrides: Partial<PanelSpecV1> = {}): PanelSpecV1 {
  return {
    v: 1,
    title: "Top meshes",
    chart: "bar",
    span: 1,
    query: { v: 1, metric: "top_meshes", range: "inherit", limit: 10 },
    ...overrides,
  } as PanelSpecV1;
}

/** A `PanelContext` whose `api.query` resolves to `rows`, recording the call. */
function ctxFor(rows: unknown, params = RANGE) {
  const calls: unknown[] = [];
  const api = {
    query: async (q: unknown) => {
      calls.push(q);
      return rows;
    },
  } as unknown as PanelContext["api"];
  const ctx = {
    api,
    baseUrl: "http://localhost:4318",
    apiKey: "k",
    params,
    filters: { window: "1h" },
    surface: "overview",
    capabilities: { hasFirstPerson: false },
    actions: {
      selectSession: () => {},
      setTimeRange: () => {},
      setFilters: () => {},
    },
    live: { presence: null, enabled: false, status: "idle", subscribe: () => () => {} },
    settings: {},
    signal: new AbortController().signal,
  } as unknown as PanelDataContext;
  return { ctx, calls };
}

/** Load and render one spec panel, returning what it drew. */
async function draw(definition: PanelSpecV1, rows: unknown, params = RANGE) {
  const panel = specPanel({ id: "p1", spec: definition });
  const { ctx, calls } = ctxFor(rows, params);
  const data = await panel.load!(ctx);
  render(<>{panel.render({ data, ctx })}</>);
  return { calls, data };
}

describe("specPanel", () => {
  it("is an ordinary PanelDefinition, prefixed so a built-in can never collide", () => {
    const panel = specPanel({ id: "abc", spec: spec({ span: 2, note: "A reading." }) });
    expect(panel.id).toBe("spec:abc");
    expect(isSpecPanelId(panel.id)).toBe(true);
    expect(isSpecPanelId("top-meshes")).toBe(false);
    expect(specIdFromPanelId(panel.id)).toBe("abc");
    expect(specIdFromPanelId("top-meshes")).toBeUndefined();
    expect(specPanelId("abc")).toBe("spec:abc");
    expect(panel.title).toBe("Top meshes");
    // The agent's one-line reading becomes the subtitle: it is the part a person
    // actually reads a week later.
    expect(panel.subtitle).toBe("A reading.");
    expect(panel.span).toBe(2);
    expect(typeof panel.render).toBe("function");
    // No settings, so ADR 0039's persistence is pure show/hide, keyed by id.
    expect(panel.settings).toBeUndefined();
  });

  it("omits the subtitle when the spec carries no note", () => {
    expect(specPanel({ id: "abc", spec: spec() }).subtitle).toBeUndefined();
  });

  it("resolves `inherit` to the host's active window on every load", async () => {
    const { calls } = await draw(spec(), [{ mesh: "crate", count: 9 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      metric: "top_meshes",
      range: RANGE,
      limit: 10,
      // A panel draws rows; the envelope is the host's business.
      format: "full",
    });
  });

  it("leaves a pinned window alone — that spec is about one period", () => {
    const pinned = { since: 1, until: 2 };
    const query = specQuery(
      spec({ query: { v: 1, metric: "top_meshes", range: pinned } as never }),
      RANGE,
    );
    expect(query.range).toEqual(pinned);
  });

  it("falls back to a bounded window when the host's params carry no range", async () => {
    // An unbounded query is the one thing the DSL must never be handed, so a
    // host that has not resolved its filter bar yet gets a default window
    // rather than a query the collector would refuse.
    const { calls } = await draw(spec(), [], {} as typeof RANGE);
    const range = (calls[0] as { range: { since: number; until: number } }).range;
    expect(range.until).toBeGreaterThan(range.since);
  });
});

describe("every chart kind draws from fixture rows", () => {
  const cases: {
    chart: PanelChartKind;
    metric: string;
    rows: unknown;
    /** What the drawing looks like, asserted against the rendered document. */
    expect: (body: HTMLElement) => void;
  }[] = [
    {
      chart: "bar",
      metric: "top_meshes",
      rows: [
        { mesh: "crate", count: 9 },
        { mesh: "door", count: 3 },
      ],
      expect: () => {
        expect(screen.getByText("crate")).toBeTruthy();
        expect(screen.getByText("door")).toBeTruthy();
      },
    },
    {
      chart: "table",
      metric: "event_counts",
      rows: [{ event_type: "pointer_click", count: 12 }],
      expect: () => {
        expect(screen.getByText("pointer_click")).toBeTruthy();
        expect(screen.getByRole("table")).toBeTruthy();
      },
    },
    {
      chart: "stat",
      metric: "perf_summary",
      // A single-record metric answers with a bare object, not an array of one.
      rows: { samples: 40, avg_fps: 58.5, min_fps: 31, p50_fps: 60 },
      expect: () => {
        expect(screen.getByText("avg_fps")).toBeTruthy();
      },
    },
    {
      chart: "line",
      metric: "timeseries",
      rows: [
        { bucket: 1, events: 4, avg_fps: 60 },
        { bucket: 2, events: 9, avg_fps: 58 },
      ],
      expect: (container) => {
        expect(container.querySelector("polyline")).toBeTruthy();
        expect(container.querySelector("polygon")).toBeNull();
      },
    },
    {
      chart: "area",
      metric: "timeseries",
      rows: [
        { bucket: 1, events: 4, avg_fps: 60 },
        { bucket: 2, events: 9, avg_fps: 58 },
      ],
      expect: (container) => {
        expect(container.querySelector("polyline")).toBeTruthy();
        expect(container.querySelector("polygon")).toBeTruthy();
      },
    },
    {
      chart: "heatmap2d",
      metric: "pointer_heatmap",
      rows: [{ gx: 1, gy: 2, count: 5 }],
      expect: (container) => {
        expect(container.querySelector("canvas")).toBeTruthy();
      },
    },
  ];

  for (const testCase of cases) {
    it(`draws a ${testCase.chart}`, async () => {
      await draw(
        spec({
          chart: testCase.chart,
          query: { v: 1, metric: testCase.metric, range: "inherit" } as never,
        }),
        testCase.rows,
      );
      testCase.expect(document.body);
    });
  }

  it("draws the empty state rather than a blank panel", async () => {
    await draw(spec(), []);
    expect(screen.getByText("No data in range.")).toBeTruthy();
  });

  it("renders the 3D view lazily, so a spec panel costs no Babylon until drawn", async () => {
    // The world3d branch is a `React.lazy` boundary: what renders synchronously
    // is the Suspense fallback, which is exactly the point — `@babylonjs/*` is
    // not in this module's static import graph.
    await draw(
      spec({
        chart: "world3d",
        query: { v: 1, metric: "world_heatmap", range: "inherit" } as never,
      }),
      [{ vx: 0, vy: 0, vz: 0, count: 3 }],
    );
    expect(screen.getByText("Loading 3D view…")).toBeTruthy();
  });
});

describe("a spec that cannot be drawn", () => {
  it("shows the validator's message inline instead of throwing", async () => {
    // A line over a ranking: there is no axis to walk along. This is a spec that
    // was valid when pinned and is not any more — the case the inline error
    // exists for.
    const { data } = await draw(spec({ chart: "line" }), []);
    expect(data.error).toMatch(/ordered axis/);
    await waitFor(() => expect(screen.getByText(/This panel cannot be drawn/)).toBeTruthy());
  });

  it("shows a failed query inline too — one panel never takes the grid down", async () => {
    const panel = specPanel({ id: "p1", spec: spec() });
    const ctx = {
      ...ctxFor([]).ctx,
      api: {
        query: async () => {
          throw new Error("HTTP 503");
        },
      },
    } as unknown as PanelDataContext;
    const data = await panel.load!(ctx);
    expect(data.error).toBe("HTTP 503");
    render(<>{panel.render({ data, ctx })}</>);
    expect(screen.getByText(/HTTP 503/)).toBeTruthy();
  });
});

describe("resolveEncoding", () => {
  it("fills the channels a spec left open from the metric's own columns", () => {
    expect(resolveEncoding(spec())).toEqual({ x: "mesh", y: "count" });
  });

  it("lets the spec override what the metric would have chosen", () => {
    expect(resolveEncoding(spec({ encoding: { y: "count", x: "session_id" } }))).toMatchObject({
      x: "session_id",
      y: "count",
    });
  });

  it("prefers the ordered axis over the label for a series", () => {
    const trend = spec({
      chart: "line",
      query: { v: 1, metric: "mesh_trend", range: "inherit" } as never,
    });
    expect(resolveEncoding(trend)).toEqual({ x: "bucket", y: "count" });
  });
});

/** A `CollectorApi` whose `panels()` resolves to `rows` (or rejects). */
function apiWith(rows: PanelSpecRow[] | Error): CollectorApi {
  return {
    panels: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  } as unknown as CollectorApi;
}

function row(id: string, value: unknown): PanelSpecRow {
  return {
    id,
    projectId: "p1",
    spec: value as PanelSpecV1,
    authorKind: "agent",
    authorKeyId: "k1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("loadSpecPanels", () => {
  it("maps stored rows to panels, in the order the collector returned them", async () => {
    const result = await loadSpecPanels(
      apiWith([row("a", spec({ title: "First" })), row("b", spec({ title: "Second" }))]),
    );
    expect(result.errors).toEqual([]);
    expect(result.panels.map((panel) => panel.id)).toEqual(["spec:a", "spec:b"]);
    expect(result.panels.map((panel) => panel.title)).toEqual(["First", "Second"]);
    expect(result.rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("skips a structurally invalid spec, reporting it — one bad row is not a blank grid", async () => {
    const result = await loadSpecPanels(
      apiWith([
        row("good", spec()),
        row("shape", { v: 1, title: "Broken", chart: "pie" }),
        row("also-good", spec({ title: "Still here" })),
      ]),
    );
    expect(result.panels.map((panel) => panel.id)).toEqual(["spec:good", "spec:also-good"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ source: "shape", code: "invalid-panel" });
  });

  it("skips a spec the registry cannot answer, and says why", async () => {
    const result = await loadSpecPanels(
      apiWith([
        row("gone", spec({ query: { v: 1, metric: "retired_metric", range: "inherit" } as never })),
        row("fine", spec()),
      ]),
    );
    expect(result.panels.map((panel) => panel.id)).toEqual(["spec:fine"]);
    expect(result.errors[0]!.message).toMatch(/unknown metric/);
  });

  it("turns an unreachable collector into one error and an empty list, never a throw", async () => {
    const result = await loadSpecPanels(apiWith(new Error("Failed to fetch")));
    expect(result.panels).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      { source: "api/v1/panels", code: "manifest-fetch", message: "Failed to fetch" },
    ]);
  });
});

describe("CollectorApi.query", () => {
  it("sends the whole document URL-encoded in `q`, defaulting the envelope to full", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        calls.push(url.toString());
        return { ok: true, status: 200, json: async () => [] };
      }) as unknown as typeof fetch,
    );
    const api = new CollectorApi("http://localhost:4318", "k");
    await api.query({ v: 1, metric: "top_meshes", range: RANGE });

    const url = new URL(calls[0]!);
    expect(url.pathname).toBe("/api/v1/query");
    expect(JSON.parse(url.searchParams.get("q")!)).toEqual({
      v: 1,
      metric: "top_meshes",
      range: RANGE,
      format: "full",
    });
  });

  it("lets a caller ask for an envelope instead", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        calls.push(url.toString());
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );
    const api = new CollectorApi("http://localhost:4318", "k");
    await api.query({ v: 1, metric: "top_meshes", range: RANGE, format: "summary" });
    expect(JSON.parse(new URL(calls[0]!).searchParams.get("q")!).format).toBe("summary");
  });
});
