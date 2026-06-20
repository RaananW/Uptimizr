"use client";

import { useMemo, useState } from "react";
import { Panel } from "./Panel";

/** Scene metadata surfaced by `/api/projects` from the local registry. */
export interface SceneMeta {
  id: string;
  label: string;
  description: string;
  cameraMode: "viewer" | "first-person";
  engines: string[];
  defaultEngine: string;
  builtin: boolean;
}

/** A registry project, optionally bound to a buildable scene. */
export interface SceneProject {
  id: string;
  name: string;
  apiKey: string;
  scene?: SceneMeta;
}

/** Friendly engine labels (ids mirror `@uptimizr/example-playground`). */
const ENGINE_LABELS: Record<string, string> = {
  babylon: "Babylon.js",
  "babylon-lite": "Babylon (lite)",
  three: "three.js",
  playcanvas: "PlayCanvas",
  r3f: "react-three-fiber",
  aframe: "A-Frame",
};

function engineLabel(id: string): string {
  return ENGINE_LABELS[id] ?? id;
}

/** One scene card: pick an engine, open analytics, or launch the live overlay. */
function SceneCard({
  project,
  playgroundUrl,
  onView,
  onOpenOverlay,
}: {
  project: SceneProject;
  playgroundUrl: string;
  onView: (project: SceneProject) => void;
  onOpenOverlay: (project: SceneProject, engine: string) => void;
}) {
  const scene = project.scene;
  const engines = scene?.engines.length ? scene.engines : [];
  const [engine, setEngine] = useState(scene?.defaultEngine ?? engines[0] ?? "");
  const canOverlay = playgroundUrl.length > 0 && engine.length > 0;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-fg-hi">{scene?.label ?? project.name}</h3>
          <p className="text-xs text-fg-muted">{project.name}</p>
        </div>
        {scene ? (
          <span className="shrink-0 rounded-full border border-edge bg-ink/50 px-2 py-0.5 text-[11px] text-fg-muted">
            {scene.cameraMode === "first-person" ? "first-person" : "viewer"}
          </span>
        ) : null}
      </div>

      {scene?.description ? (
        <p className="text-xs leading-relaxed text-fg-muted">{scene.description}</p>
      ) : (
        <p className="text-xs leading-relaxed text-fg-muted">
          A project without scene metadata — open its analytics directly.
        </p>
      )}

      {engines.length > 1 ? (
        <label className="flex flex-col gap-1 text-[11px] text-fg-muted">
          Engine
          <select
            className="rounded-md border border-edge bg-ink px-2 py-1.5 text-xs text-fg outline-none focus:border-saffron"
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
          >
            {engines.map((id) => (
              <option key={id} value={id}>
                {engineLabel(id)}
              </option>
            ))}
          </select>
        </label>
      ) : engines.length === 1 ? (
        <p className="text-[11px] text-fg-muted">Engine: {engineLabel(engines[0]!)}</p>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => onView(project)}
          className="rounded-md bg-amber px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-ember"
        >
          View analytics
        </button>
        {scene ? (
          <button
            type="button"
            disabled={!canOverlay}
            onClick={() => onOpenOverlay(project, engine)}
            className="rounded-md border border-edge px-3 py-1.5 text-xs text-fg transition hover:border-amber hover:text-fg-hi disabled:opacity-40"
          >
            Open live scene
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Landing scene-selector: cards for every scene/project in the local registry,
 * each linking to its analytics and (for scenes) launching the playground
 * feature-testing overlay embedded in an iframe. Scenes are grouped by camera
 * mode so the viewer and first-person experiences read separately.
 */
export function SceneSelector({
  projects,
  playgroundUrl,
  onView,
}: {
  projects: SceneProject[];
  playgroundUrl: string;
  onView: (project: SceneProject) => void;
}) {
  // Active overlay (project + engine) shown in the embedded iframe, if any.
  const [overlay, setOverlay] = useState<{ url: string; title: string } | null>(null);

  const groups = useMemo(() => {
    const viewer: SceneProject[] = [];
    const firstPerson: SceneProject[] = [];
    const other: SceneProject[] = [];
    for (const p of projects) {
      if (!p.scene) other.push(p);
      else if (p.scene.cameraMode === "first-person") firstPerson.push(p);
      else viewer.push(p);
    }
    return { viewer, firstPerson, other };
  }, [projects]);

  const openOverlay = (project: SceneProject, engine: string) => {
    const scene = project.scene;
    if (!scene || !playgroundUrl) return;
    const url = `${playgroundUrl.replace(/\/$/, "")}/?scene=${encodeURIComponent(
      scene.id,
    )}&engine=${encodeURIComponent(engine)}`;
    setOverlay({ url, title: `${scene.label} · ${engineLabel(engine)}` });
  };

  const renderGroup = (title: string, list: SceneProject[]) =>
    list.length > 0 ? (
      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((p) => (
            <SceneCard
              key={p.id}
              project={p}
              playgroundUrl={playgroundUrl}
              onView={onView}
              onOpenOverlay={openOverlay}
            />
          ))}
        </div>
      </section>
    ) : null;

  return (
    <Panel
      title="Scenes"
      subtitle="Pick a scene to explore its analytics, or open it live to test capture."
    >
      <div className="flex flex-col gap-6">
        {renderGroup("Viewer", groups.viewer)}
        {renderGroup("First-person", groups.firstPerson)}
        {renderGroup("Other projects", groups.other)}
      </div>

      {overlay ? (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="Live scene overlay"
        >
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-edge bg-panel">
            <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
              <p className="text-sm text-fg">{overlay.title}</p>
              <div className="flex items-center gap-2">
                <a
                  href={overlay.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-edge px-3 py-1.5 text-xs text-fg transition hover:border-amber hover:text-fg-hi"
                >
                  Open in new tab ↗
                </a>
                <button
                  type="button"
                  onClick={() => setOverlay(null)}
                  className="rounded-md border border-edge px-3 py-1.5 text-xs text-fg transition hover:border-amber hover:text-fg-hi"
                >
                  Close ✕
                </button>
              </div>
            </div>
            <iframe
              title={overlay.title}
              src={overlay.url}
              className="h-full w-full flex-1 bg-ink"
            />
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
