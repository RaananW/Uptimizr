"use client";

import { useEffect, useMemo, useState } from "react";

import type { HeatmapBin, MeshCount } from "../../api";
import { PointerHeatmapCanvas } from "../../panels/views";

/**
 * Per-mesh texture-space (UV) heatmap panel body (#149). A mesh `<select>` picks
 * one object; the view then self-fetches that mesh's UV-binned interaction heat
 * via `fetchHeatmap` and renders it on the shared {@link PointerHeatmapCanvas}
 * (UV space is a unit square, so the 2D pointer canvas fits exactly). Defaults to
 * the most-interacted mesh and re-fetches whenever the selection changes.
 */
export function MeshUvHeatmapView({
  meshes,
  gridSize,
  fetchHeatmap,
}: {
  meshes: MeshCount[];
  gridSize: number;
  fetchHeatmap: (mesh: string) => Promise<HeatmapBin[]>;
}) {
  const options = useMemo(() => meshes.filter((m) => m.mesh), [meshes]);
  const [selected, setSelected] = useState<string>(options[0]?.mesh ?? "");
  const [bins, setBins] = useState<HeatmapBin[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the selection valid as the mesh list changes (filters/range switch).
  useEffect(() => {
    if (options.length === 0) {
      setSelected("");
    } else if (!options.some((m) => m.mesh === selected)) {
      setSelected(options[0]!.mesh);
    }
  }, [options, selected]);

  useEffect(() => {
    if (!selected) {
      setBins([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchHeatmap(selected)
      .then((rows) => {
        if (!cancelled) setBins(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load heatmap");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, fetchHeatmap]);

  if (options.length === 0) {
    return <p className="text-sm text-muted">No mesh interactions in this range yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted">Mesh</span>
        <select
          className="rounded-md border border-edge bg-surface px-2 py-1"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {options.map((m) => (
            <option key={m.mesh} value={m.mesh}>
              {m.mesh} ({m.count})
            </option>
          ))}
        </select>
      </label>
      <div className="flex min-h-[8rem] justify-center">
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <PointerHeatmapCanvas
            bins={bins}
            gridSize={gridSize}
            className="rounded-lg border border-edge"
          />
        )}
      </div>
    </div>
  );
}

export const MESH_UV_HEATMAP_TITLE = "Mesh UV heatmap";
export const MESH_UV_HEATMAP_SUBTITLE = "Texture-space attention on one mesh";
export const MESH_UV_HEATMAP_HELP =
  "Where on a mesh's surface (its UV/texture space) interactions concentrate. " +
  "Pick a mesh to see clicks, picks, and hovers binned across its unwrapped texture.";
