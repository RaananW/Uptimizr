"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchSessionEvents } from "@uptimizr/replay";
import { Panel } from "./Panel";

/** The captured event union, derived from the replay fetcher to avoid a direct schema dep. */
type AnyEvent = Awaited<ReturnType<typeof fetchSessionEvents>>[number];

type Phase = "loading" | "ready" | "empty" | "error";

/** A single metadata row: a label and a pre-formatted value. */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-xs text-fg-muted">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-fg" title={value}>
        {value}
      </span>
    </div>
  );
}

function MetaSection({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-edge bg-ink/40 p-3">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
        {title}
      </p>
      {rows.map(([label, value]) => (
        <MetaRow key={label} label={label} value={value} />
      ))}
    </div>
  );
}

/** Stringify a leaf metadata value for display, dropping empty/undefined. */
function show(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) return value.join(" × ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Build `[label, value]` rows from an object, skipping missing fields. */
function rowsFrom(entries: Array<[string, unknown]>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [label, raw] of entries) {
    const v = show(raw);
    if (v != null) out.push([label, v]);
  }
  return out;
}

/**
 * Session data inspector: surfaces the metadata that was actually sent (envelope,
 * page context, device/GPU, scene, connector, user) and an exhaustive,
 * per-event-type breakdown. Each type can be toggled to show/hide its data in the
 * replay overlay, and expanded to inspect a sample of raw payloads.
 */
export function SessionInspector({
  baseUrl,
  apiKey,
  sessionId,
  hiddenTypes,
  onToggleType,
  onSetAllHidden,
}: {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  hiddenTypes: ReadonlySet<string>;
  onToggleType: (type: string) => void;
  onSetAllHidden: (hidden: boolean, types: string[]) => void;
}) {
  const [events, setEvents] = useState<AnyEvent[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setError(null);
    setEvents([]);
    setExpanded(new Set());
    void (async () => {
      try {
        const ev = await fetchSessionEvents({ endpoint: baseUrl, apiKey, sessionId });
        if (cancelled) return;
        setEvents(ev);
        setPhase(ev.length === 0 ? "empty" : "ready");
      } catch (err) {
        if (cancelled) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : "Failed to load session data.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, apiKey, sessionId]);

  const { meta, byType, allTypes, sorted } = useMemo(() => {
    const s = [...events].sort((a, b) => a.ts - b.ts);
    const counts = new Map<string, number>();
    for (const e of s) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    const types = [...counts.keys()].sort();
    const start = s[0];
    const end = s[s.length - 1];
    const startEvent = s.find((e) => e.type === "session_start");
    return {
      meta: { start, end, startEvent },
      byType: counts,
      allTypes: types,
      sorted: s,
    };
  }, [events]);

  if (phase !== "ready") {
    return (
      <Panel title="Session data" subtitle="Metadata and captured event breakdown">
        <p className="py-6 text-center text-sm text-fg-muted">
          {phase === "loading"
            ? "Loading session data…"
            : phase === "empty"
              ? "No events captured for this session."
              : (error ?? "Session data unavailable.")}
        </p>
      </Panel>
    );
  }

  const start = meta.start;
  const end = meta.end;
  const startEvent = meta.startEvent;
  const durationMs = start && end ? end.ts - start.ts : 0;
  const fmtTs = (ts?: number) => (ts ? new Date(ts).toLocaleString() : "—");
  const fmtDur = (ms: number) => {
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  // Envelope is shared by every event; read it off the first one.
  const env = start;
  const pageMeta = env?.pageMeta;

  const identityRows = rowsFrom([
    ["Project", env?.projectId],
    ["Session", env?.sessionId],
    ["Visitor", env?.visitorId],
    ["SDK", env?.sdkVersion],
    ["Scene ID", env?.sceneId],
    ["URL", env?.url],
    ["Started", fmtTs(start?.ts)],
    ["Ended", fmtTs(end?.ts)],
    ["Duration", fmtDur(durationMs)],
    ["Events", String(sorted.length)],
  ]);

  const pageRows = pageMeta
    ? rowsFrom([
        ["Title", pageMeta.title],
        ["Language", pageMeta.language],
        ["Referrer", pageMeta.referrer],
        ["Viewport", pageMeta.viewport],
        ["Device pixel ratio", pageMeta.devicePixelRatio],
      ])
    : [];

  const device = startEvent?.type === "session_start" ? startEvent.device : undefined;
  const graphics = startEvent?.type === "session_start" ? startEvent.graphics : undefined;
  const scene = startEvent?.type === "session_start" ? startEvent.scene : undefined;
  const connector = startEvent?.type === "session_start" ? startEvent.connector : undefined;
  const user = startEvent?.type === "session_start" ? startEvent.user : undefined;

  const deviceRows = rowsFrom([
    ["Engine", device?.engine],
    ["Graphics API", graphics?.api],
    ["Backend", graphics?.backend],
    ["API version", graphics?.apiVersion],
    ["Shading language", graphics?.shadingLanguage],
    ["GPU vendor", device?.vendor],
    ["GPU renderer", device?.renderer],
    ["Max texture size", device?.maxTextureSize],
    ["CPU cores", device?.hardwareConcurrency],
    ["Device memory (GB)", device?.deviceMemoryGb],
    ["Mobile", device?.isMobile],
  ]);

  const sceneRows = rowsFrom([
    ["Connector", connector ? [connector.name, connector.version].filter(Boolean).join(" ") : null],
    ["Coordinate system", connector?.coordinateSystem],
    ["Description", scene?.description],
    ["Camera type", scene?.cameraType],
    ["Camera name", scene?.cameraName],
    ["Mesh count", scene?.meshCount],
    ["User id", user?.id],
    ["User traits", user?.traits],
  ]);

  const allHidden = allTypes.every((t) => hiddenTypes.has(t));

  return (
    <Panel
      title="Session data"
      subtitle="Metadata that was sent and a per-feature breakdown — toggle a type to show/hide it in the replay, expand to inspect raw payloads"
      help={
        <>
          Project-level metadata beyond the <strong>Project ID</strong> isn&apos;t stored in the OSS
          collector (Phase 1) — everything here is derived from the session&apos;s own events. The{" "}
          <strong>Device / graphics</strong> and <strong>Scene / connector</strong> blocks come from
          the one-time <code>session_start</code> event.
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MetaSection title="Identity" rows={identityRows} />
        <MetaSection title="Page context" rows={pageRows} />
        <MetaSection title="Device / graphics" rows={deviceRows} />
        <MetaSection title="Scene / connector" rows={sceneRows} />
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
            Captured features ({allTypes.length} event types)
          </p>
          <button
            type="button"
            onClick={() => onSetAllHidden(!allHidden, allTypes)}
            className="rounded-md border border-edge px-2 py-1 text-xs text-fg transition hover:border-amber hover:text-fg-hi"
          >
            {allHidden ? "Show all" : "Hide all"}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {allTypes.map((type) => {
            const visible = !hiddenTypes.has(type);
            const isExpanded = expanded.has(type);
            const samples = sorted.filter((e) => e.type === type).slice(0, 3);
            return (
              <div
                key={type}
                className={`self-start rounded-lg border border-edge bg-ink/40 ${
                  isExpanded ? "sm:col-span-2 lg:col-span-3" : ""
                }`}
              >
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={() => onToggleType(type)}
                      className="accent-amber"
                    />
                    <span className="truncate font-mono text-xs text-fg">{type}</span>
                  </label>
                  <span className="tabular-nums text-xs text-fg-muted">{byType.get(type)}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(type)) next.delete(type);
                        else next.add(type);
                        return next;
                      })
                    }
                    aria-expanded={isExpanded ? "true" : "false"}
                    className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-fg-muted transition hover:border-amber hover:text-fg-hi"
                  >
                    {isExpanded ? "Hide raw" : "Raw"}
                  </button>
                </div>
                {isExpanded ? (
                  <pre className="max-h-64 overflow-auto border-t border-edge bg-black/30 px-3 py-2 text-[10px] leading-relaxed text-fg">
                    {samples.map((e) => JSON.stringify(e, null, 2)).join("\n\n")}
                    {(byType.get(type) ?? 0) > samples.length
                      ? `\n\n… ${(byType.get(type) ?? 0) - samples.length} more`
                      : ""}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}
