"use client";

// AssistantDrawer — the dashboard's entry point to the in-browser analytics
// assistant (ADR 0050 §1, ADR 0047). It is a collapsed toggle until the user
// opens it; only then is `@uptimizr/react/assistant` pulled in, via a lazy
// `import()`. That keeps the assistant + `@mlc-ai/web-llm` runtime out of the
// dashboard's main bundle entirely — a user who never opens the assistant pays
// nothing for it (guarded by `app/__tests__/entryPurity.test.ts`). The panel
// reads through the SAME read-only collector connection the panels use, so it
// works against a real collector and, unchanged, against the demo's in-browser
// DuckDB-Wasm layer (the demo embeds this dashboard build).

import dynamic from "next/dynamic";
import { useState } from "react";
import { annotationTargetFor, type FilterState } from "@uptimizr/react";

// The `import()` here is the code-split seam: the panel and everything it pulls
// (agent-core, and — lazily inside it — the WebLLM runtime) land in an on-demand
// chunk, never the main bundle. `ssr: false` because the assistant is a
// browser-only, WebGPU/localStorage-driven surface.
const AssistantPanel = dynamic(
  () => import("@uptimizr/react/assistant").then((m) => m.AssistantPanel),
  {
    ssr: false,
    loading: () => <p className="text-sm text-fg-muted">Loading assistant…</p>,
  },
);

interface AssistantDrawerProps {
  /** Collector base URL the connected dashboard is reading from. */
  collectorUrl: string;
  /** Project API key for the active connection. */
  apiKey: string;
  /**
   * The dashboard's active filters. They pre-fill the target of an
   * "Annotate this" note (#310) — the scene being looked at, the window being
   * shown — so a note lands where the user was actually looking.
   */
  filters: FilterState;
  /**
   * Called after the assistant pins an answer as a panel (#315), so the grid
   * can pick the new panel up without a reload.
   */
  onPinned?: () => void;
}

/**
 * A collapsible panel that mounts `<AssistantPanel>` on first open, wired to the
 * active project's collector connection.
 */
export function AssistantDrawer({ collectorUrl, apiKey, filters, onPinned }: AssistantDrawerProps) {
  const [open, setOpen] = useState(false);

  return (
    <section
      className="rounded-xl border border-edge bg-panel p-4"
      aria-label="Analytics assistant"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-semibold text-fg-hi">Analytics assistant</h2>
          <p className="text-xs text-fg-muted">
            Ask natural-language questions of this project&apos;s analytics. Runs in your browser
            against a local or bring-your-own model — read-only, aggregate, no data egress by
            default.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="shrink-0 rounded-md bg-amber px-4 py-2 text-sm font-medium text-ink transition hover:bg-ember"
        >
          {open ? "Hide assistant" : "Ask the assistant"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 border-t border-edge pt-4">
          <AssistantPanel
            collectorUrl={collectorUrl}
            apiKey={apiKey}
            annotationTarget={annotationTargetFor(filters)}
            onPinned={onPinned}
          />
        </div>
      ) : null}
    </section>
  );
}
