"use client";

import type { SceneInfo } from "@/lib/api";
import {
  formatSource,
  INPUT_SOURCES,
  TIME_PRESETS,
  type FilterState,
  type TimeWindow,
} from "@/lib/filters";

/** Convert epoch-ms to the value a `datetime-local` input expects (local time). */
function toLocalInput(ms: number | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/** Parse a `datetime-local` value back to epoch-ms (local time), or `undefined`. */
function fromLocalInput(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The global filter bar: time window (presets + custom range), scene selector,
 * and input-source selector. Changes are pushed up immediately; the page
 * debounces the resulting refetch.
 */
export function GlobalFilters({
  filters,
  scenes,
  onChange,
  busy,
}: {
  filters: FilterState;
  scenes: SceneInfo[];
  onChange: (next: FilterState) => void;
  busy?: boolean;
}) {
  const set = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });

  return (
    <section className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-edge bg-panel p-4">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">Time window</span>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Time window">
          {TIME_PRESETS.map((p) => {
            const active = filters.window === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => set({ window: p.id as TimeWindow })}
                className={`rounded-md border px-2.5 py-1.5 text-xs transition ${
                  active
                    ? "border-amber bg-amber/10 text-saffron"
                    : "border-edge text-fg hover:border-amber/60 hover:text-fg-hi"
                }`}
              >
                {p.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() =>
              set({
                window: "custom",
                since: filters.since ?? Date.now() - 86_400_000,
                until: filters.until ?? Date.now(),
              })
            }
            className={`rounded-md border px-2.5 py-1.5 text-xs transition ${
              filters.window === "custom"
                ? "border-amber bg-amber/10 text-saffron"
                : "border-edge text-fg hover:border-amber/60 hover:text-fg-hi"
            }`}
          >
            Custom
          </button>
        </div>
      </div>

      {filters.window === "custom" ? (
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            From
            <input
              type="datetime-local"
              value={toLocalInput(filters.since)}
              onChange={(e) => set({ since: fromLocalInput(e.target.value) })}
              className="rounded-md border border-edge bg-ink px-2 py-1.5 text-xs text-fg outline-none focus:border-saffron"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            To
            <input
              type="datetime-local"
              value={toLocalInput(filters.until)}
              onChange={(e) => set({ until: fromLocalInput(e.target.value) })}
              className="rounded-md border border-edge bg-ink px-2 py-1.5 text-xs text-fg outline-none focus:border-saffron"
            />
          </label>
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Scene
        <select
          value={filters.scene ?? ""}
          onChange={(e) => set({ scene: e.target.value || undefined })}
          className="min-w-40 rounded-md border border-edge bg-ink px-2 py-1.5 text-xs text-fg outline-none focus:border-saffron"
        >
          <option value="">All scenes</option>
          {scenes.map((s) => (
            <option key={s.scene_id} value={s.scene_id}>
              {s.scene_id} ({s.events.toLocaleString()})
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Input source
        <select
          value={filters.source ?? ""}
          onChange={(e) => set({ source: (e.target.value || undefined) as FilterState["source"] })}
          className="min-w-36 rounded-md border border-edge bg-ink px-2 py-1.5 text-xs text-fg outline-none focus:border-saffron"
        >
          <option value="">All sources</option>
          {INPUT_SOURCES.map((s) => (
            <option key={s} value={s}>
              {formatSource(s)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Camera mode
        <select
          value={filters.cameraMode ?? ""}
          onChange={(e) =>
            set({ cameraMode: (e.target.value || undefined) as FilterState["cameraMode"] })
          }
          className="min-w-36 rounded-md border border-edge bg-ink px-2 py-1.5 text-xs text-fg outline-none focus:border-saffron"
        >
          <option value="">All cameras</option>
          <option value="viewer">Viewer (orbit)</option>
          <option value="first-person">First-person (walk)</option>
        </select>
      </label>

      <span
        className={`ml-auto text-xs ${busy ? "text-saffron" : "text-fg-muted"}`}
        aria-live="polite"
      >
        {busy ? "Refreshing…" : "Up to date"}
      </span>
    </section>
  );
}
