import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePanelData } from "../panels/usePanelData";
import type { PanelContext, PanelDefinition } from "../panels/contract";

afterEach(cleanup);

/** A panel whose loads stay pending until the test settles them. */
function deferredPanel() {
  const calls: Array<{
    ctx: PanelContext & { signal: AbortSignal };
    resolve: (v: string) => void;
  }> = [];
  const panel = {
    id: "p",
    title: "P",
    load: (ctx: PanelContext & { signal: AbortSignal }) =>
      new Promise<string>((resolve) => calls.push({ ctx, resolve })),
    render: () => null,
  } as unknown as PanelDefinition<string>;
  return { panel, calls };
}

const ctxWith = (until: number, extra: Partial<PanelContext> = {}) =>
  ({
    surface: "session",
    sessionId: "s1",
    params: { since: 0, until },
    settings: {},
    ...extra,
  }) as unknown as PanelContext;

describe("usePanelData", () => {
  it("coalesces a refresh that lands while a load is in flight", async () => {
    const { panel, calls } = deferredPanel();
    const { result, rerender } = renderHook(
      ({ ctx, revision }) => usePanelData(panel, ctx, revision),
      { initialProps: { ctx: ctxWith(100), revision: 0 } },
    );
    expect(calls).toHaveLength(1);

    // Two refreshes while the first load runs: neither aborts it nor starts one.
    rerender({ ctx: ctxWith(200), revision: 1 });
    rerender({ ctx: ctxWith(300), revision: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ctx.signal.aborted).toBe(false);

    // The first result paints, then exactly one follow-up runs on the latest ctx.
    await act(async () => calls[0]!.resolve("first"));
    expect(result.current.data).toBe("first");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.ctx.params).toEqual({ since: 0, until: 300 });

    await act(async () => calls[1]!.resolve("second"));
    await waitFor(() => expect(result.current.data).toBe("second"));
    expect(calls).toHaveLength(2);
  });

  it("aborts and reloads at once when the session changes", async () => {
    const { panel, calls } = deferredPanel();
    const { result, rerender } = renderHook(
      ({ ctx, revision }) => usePanelData(panel, ctx, revision),
      { initialProps: { ctx: ctxWith(100), revision: 0 } },
    );
    rerender({ ctx: ctxWith(100, { sessionId: "s2" }), revision: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.ctx.signal.aborted).toBe(true);

    // The superseded result never paints.
    await act(async () => calls[0]!.resolve("stale"));
    await act(async () => calls[1]!.resolve("fresh"));
    expect(result.current.data).toBe("fresh");
  });

  it("aborts and reloads at once on a filter change without a refresh", () => {
    const { panel, calls } = deferredPanel();
    const { rerender } = renderHook(({ ctx, revision }) => usePanelData(panel, ctx, revision), {
      initialProps: { ctx: ctxWith(100), revision: 0 },
    });
    rerender({ ctx: ctxWith(500), revision: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.ctx.signal.aborted).toBe(true);
  });

  it("refreshes immediately when nothing is in flight", async () => {
    const { panel, calls } = deferredPanel();
    const { rerender } = renderHook(({ ctx, revision }) => usePanelData(panel, ctx, revision), {
      initialProps: { ctx: ctxWith(100), revision: 0 },
    });
    await act(async () => calls[0]!.resolve("a"));
    rerender({ ctx: ctxWith(200), revision: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.ctx.params).toEqual({ since: 0, until: 200 });
  });
});
