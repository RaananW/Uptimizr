"use client";

import { useEffect, useRef, useState } from "react";
import type { SceneProxyMesh, WorldHeatmapBin } from "@/lib/api";
import { heatRgb } from "@/lib/heat";
import {
  attachDoubleClickFocus,
  disableWheelZoom,
  resetFocus,
  stepZoom,
  type OrbitFocusCamera,
  type OrbitHome,
} from "@/lib/orbitZoom";
import { attachMeshHover, type HoverTip } from "@/lib/sceneHover";
import { Panel } from "./Panel";
import { ZoomButtons } from "./ZoomButtons";

type Phase = "loading" | "ready" | "empty" | "error";

/** Which layer(s) to show: both overlaid, gaze only, clicks only, or the divergence field. */
type LayerMode = "overlay" | "gaze" | "click" | "divergence";

/** Default panel chrome copy for the gaze-vs-click divergence overlay. */
export const GAZE_CLICK_TITLE = "Gaze vs. click divergence";
export const GAZE_CLICK_SUBTITLE =
  "Where viewers look (gaze) vs. where they act (clicks), voxel-binned in world space — double-click to focus";

/** Cool ramp (gaze): deep blue → cyan, the visual opposite of the warm click heat. */
function coolRgb(t: number): [number, number, number] {
  const c = Math.min(1, Math.max(0, t));
  // #1e3a8a (deep blue) → #38bdf8 (cyan)
  const r = 0.118 + (0.22 - 0.118) * c;
  const g = 0.227 + (0.74 - 0.227) * c;
  const b = 0.541 + (0.97 - 0.541) * c;
  return [r, g, b];
}

function voxelKey(v: WorldHeatmapBin): string {
  return `${v.vx}|${v.vy}|${v.vz}`;
}

/**
 * Gaze-vs-click divergence overlay — the panel BODY only (no chrome). Overlays
 * two world-space voxel grids: where viewers *look* (gaze, a cool blue→cyan
 * ramp) against where they *act* (pointer clicks, the warm heat ramp), drawn
 * over the registered scene proxy (ADR 0014). This reveals attention that never
 * converts to interaction — areas that draw the eye but not the cursor.
 *
 * The "Divergence" mode computes a per-voxel normalized difference client-side
 * (each grid normalized to its own busiest cell, so the comparison is fair) and
 * colors each cell by which signal dominates: warm = click-heavy, cool =
 * gaze-heavy. Both grids must share the same `cellSize` so the voxels align.
 *
 * Babylon loads dynamically (browser-only). {@link GazeClickDivergence3D} wraps
 * this in panel chrome for legacy call sites.
 */
export function GazeClickDivergence3DView({
  gazeVoxels,
  clickVoxels,
  cellSize,
  proxyMeshes = [],
}: {
  gazeVoxels: WorldHeatmapBin[];
  clickVoxels: WorldHeatmapBin[];
  cellSize: number;
  proxyMeshes?: SceneProxyMesh[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<OrbitFocusCamera | null>(null);
  const homeRef = useRef<OrbitHome | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<LayerMode>("overlay");
  const [tip, setTip] = useState<HoverTip | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (gazeVoxels.length === 0 && clickVoxels.length === 0 && proxyMeshes.length === 0) {
      setPhase("empty");
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | null = null;
    setPhase("loading");
    setError(null);

    void (async () => {
      try {
        const [
          { Engine },
          { Scene },
          { ArcRotateCamera },
          { HemisphericLight },
          { Vector3, Color3, Color4, Matrix },
          { MeshBuilder },
          { StandardMaterial },
        ] = await Promise.all([
          import("@babylonjs/core/Engines/engine.js"),
          import("@babylonjs/core/scene.js"),
          import("@babylonjs/core/Cameras/arcRotateCamera.js"),
          import("@babylonjs/core/Lights/hemisphericLight.js"),
          import("@babylonjs/core/Maths/math.js"),
          import("@babylonjs/core/Meshes/meshBuilder.js"),
          import("@babylonjs/core/Materials/standardMaterial.js"),
          // Side-effect: augments Mesh.prototype with thinInstance* methods.
          import("@babylonjs/core/Meshes/thinInstanceMesh.js"),
          // Side-effect: registers Babylon's `Ray` so `scene.pick()` (hover) works.
          import("@babylonjs/core/Culling/ray.js"),
        ]);
        if (disposed) return;

        const gazeMax = gazeVoxels.reduce((m, v) => Math.max(m, v.count), 1);
        const clickMax = clickVoxels.reduce((m, v) => Math.max(m, v.count), 1);

        // Frame the camera on the union of both grids (fall back to proxy AABBs).
        const allVoxels = [...gazeVoxels, ...clickVoxels];
        let cx = 0;
        let cy = 0;
        let cz = 0;
        let samples = 0;
        for (const v of allVoxels) {
          cx += (v.vx + 0.5) * cellSize;
          cy += (v.vy + 0.5) * cellSize;
          cz += (v.vz + 0.5) * cellSize;
          samples++;
        }
        if (samples === 0) {
          for (const m of proxyMeshes) {
            cx += (m.aabb[0] + m.aabb[3]) / 2;
            cy += (m.aabb[1] + m.aabb[4]) / 2;
            cz += (m.aabb[2] + m.aabb[5]) / 2;
            samples++;
          }
        }
        const center = new Vector3(cx / samples, cy / samples, cz / samples);
        let radius = cellSize * 4;
        for (const v of allVoxels) {
          const dx = (v.vx + 0.5) * cellSize - center.x;
          const dy = (v.vy + 0.5) * cellSize - center.y;
          const dz = (v.vz + 0.5) * cellSize - center.z;
          radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        for (const m of proxyMeshes) {
          const dx = (m.aabb[0] + m.aabb[3]) / 2 - center.x;
          const dy = (m.aabb[1] + m.aabb[4]) / 2 - center.y;
          const dz = (m.aabb[2] + m.aabb[5]) / 2 - center.z;
          radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }

        const engine = new Engine(canvas, true, { preserveDrawingBuffer: false });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

        const camera = new ArcRotateCamera(
          "divergence-cam",
          Math.PI / 4,
          Math.PI / 3,
          radius * 2.4,
          center,
          scene,
        );
        camera.attachControl(canvas, true);
        disableWheelZoom(camera);
        cameraRef.current = camera;
        homeRef.current = {
          target: center,
          alpha: camera.alpha,
          beta: camera.beta,
          radius: camera.radius,
        };
        new HemisphericLight("divergence-light", new Vector3(0.4, 1, 0.3), scene);

        // Faint wireframe backdrop: one thin-instanced unit box per proxy AABB.
        if (proxyMeshes.length > 0) {
          const proxyBox = MeshBuilder.CreateBox("scene-proxy", { size: 1 }, scene);
          const proxyMat = new StandardMaterial("scene-proxy-mat", scene);
          proxyMat.wireframe = true;
          proxyMat.disableLighting = true;
          proxyMat.emissiveColor = new Color3(0.32, 0.4, 0.52);
          proxyMat.alpha = 0.35;
          proxyBox.material = proxyMat;
          proxyBox.isPickable = true;
          proxyBox.thinInstanceEnablePicking = true;
          proxyBox.metadata = { hoverLabels: proxyMeshes.map((m) => m.name) };

          const pn = proxyMeshes.length;
          const proxyMatrices = new Float32Array(pn * 16);
          for (let i = 0; i < pn; i++) {
            const a = proxyMeshes[i]!.aabb;
            const sx = Math.max(a[3] - a[0], 1e-3);
            const sy = Math.max(a[4] - a[1], 1e-3);
            const sz = Math.max(a[5] - a[2], 1e-3);
            const m = Matrix.Scaling(sx, sy, sz).multiply(
              Matrix.Translation((a[0] + a[3]) / 2, (a[1] + a[4]) / 2, (a[2] + a[5]) / 2),
            );
            m.copyToArray(proxyMatrices, i * 16);
          }
          proxyBox.thinInstanceSetBuffer("matrix", proxyMatrices, 16, true);
        }

        const markerUnit = Math.max(radius * 0.02, cellSize * 0.25);
        const fitScale = markerUnit / (cellSize * 0.9);

        // Build one thin-instanced marker layer from a voxel list + colorer.
        const buildLayer = (
          name: string,
          voxels: WorldHeatmapBin[],
          maxCount: number,
          colorFor: (t: number) => [number, number, number],
          label: string,
        ): void => {
          if (voxels.length === 0) return;
          const marker = MeshBuilder.CreateSphere(
            name,
            { diameter: cellSize * 0.9, segments: 6 },
            scene,
          );
          const mat = new StandardMaterial(`${name}-mat`, scene);
          mat.diffuseColor = new Color3(1, 1, 1);
          mat.specularColor = new Color3(0, 0, 0);
          // Keep lighting ON: the per-instance `color` buffer modulates the
          // diffuse term, so disabling lighting would drop the voxel colors and
          // render every marker uncolored (matches WorldHeatmap3D).
          marker.material = mat;
          marker.metadata = { hoverLabel: label };

          const n = voxels.length;
          const matrices = new Float32Array(n * 16);
          const colors = new Float32Array(n * 4);
          for (let i = 0; i < n; i++) {
            const v = voxels[i]!;
            const t = v.count / maxCount;
            const s = fitScale * (0.5 + 0.5 * t);
            const m = Matrix.Scaling(s, s, s).multiply(
              Matrix.Translation(
                (v.vx + 0.5) * cellSize,
                (v.vy + 0.5) * cellSize,
                (v.vz + 0.5) * cellSize,
              ),
            );
            m.copyToArray(matrices, i * 16);
            const [r, g, b] = colorFor(t);
            colors[i * 4] = r;
            colors[i * 4 + 1] = g;
            colors[i * 4 + 2] = b;
            colors[i * 4 + 3] = 1;
          }
          marker.thinInstanceSetBuffer("matrix", matrices, 16, false);
          marker.thinInstanceSetBuffer("color", colors, 4, true);
        };

        if (mode === "divergence") {
          // Per-voxel normalized difference: each grid normalized to its own
          // busiest cell so the comparison is fair. diff > 0 => click-heavy
          // (warm), diff < 0 => gaze-heavy (cool); |diff| drives intensity.
          const gazeByKey = new Map(gazeVoxels.map((v) => [voxelKey(v), v]));
          const clickByKey = new Map(clickVoxels.map((v) => [voxelKey(v), v]));
          const keys = new Set([...gazeByKey.keys(), ...clickByKey.keys()]);
          const warm: WorldHeatmapBin[] = [];
          const cool: WorldHeatmapBin[] = [];
          for (const key of keys) {
            const g = (gazeByKey.get(key)?.count ?? 0) / gazeMax;
            const c = (clickByKey.get(key)?.count ?? 0) / clickMax;
            const ref = clickByKey.get(key) ?? gazeByKey.get(key)!;
            const diff = c - g;
            // Encode |diff| in `count` (0..1 → 0..1000) so buildLayer's t = 1.
            const bin: WorldHeatmapBin = {
              vx: ref.vx,
              vy: ref.vy,
              vz: ref.vz,
              count: Math.abs(diff) * 1000,
            };
            (diff >= 0 ? warm : cool).push(bin);
          }
          buildLayer("div-click", warm, 1000, heatRgb, "Click-heavy");
          buildLayer("div-gaze", cool, 1000, coolRgb, "Gaze-heavy");
        } else {
          if (mode === "overlay" || mode === "gaze") {
            buildLayer("gaze-voxel", gazeVoxels, gazeMax, coolRgb, "Gaze");
          }
          if (mode === "overlay" || mode === "click") {
            buildLayer("click-voxel", clickVoxels, clickMax, heatRgb, "Click");
          }
        }

        engine.runRenderLoop(() => scene.render());
        const onResize = () => engine.resize();
        window.addEventListener("resize", onResize);
        const detachHover = attachMeshHover(scene, canvas, setTip);
        const detachFocus = attachDoubleClickFocus(scene, canvas, camera);

        setPhase("ready");
        cleanup = () => {
          window.removeEventListener("resize", onResize);
          detachHover();
          detachFocus();
          setTip(null);
          cameraRef.current = null;
          homeRef.current = null;
          scene.dispose();
          engine.dispose();
        };
      } catch (err) {
        if (disposed) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : "Failed to render overlay.");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [gazeVoxels, clickVoxels, cellSize, proxyMeshes, mode]);

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        className="aspect-video w-full rounded-lg border border-edge bg-ink"
      />
      {tip ? (
        <div
          className="pointer-events-none absolute z-10 max-w-64 truncate rounded border border-edge bg-ink/90 px-1.5 py-0.5 text-xs text-white shadow backdrop-blur"
          style={{ left: tip.x + 12, top: tip.y + 12 }}
        >
          {tip.label}
        </div>
      ) : null}
      {phase === "ready" ? (
        <>
          <div className="absolute left-3 top-3 flex items-center gap-1 rounded-md border border-edge bg-ink/80 p-0.5 text-xs backdrop-blur">
            <ModeButton active={mode === "overlay"} onClick={() => setMode("overlay")}>
              Overlay
            </ModeButton>
            <ModeButton active={mode === "gaze"} onClick={() => setMode("gaze")}>
              Gaze
            </ModeButton>
            <ModeButton active={mode === "click"} onClick={() => setMode("click")}>
              Clicks
            </ModeButton>
            <ModeButton active={mode === "divergence"} onClick={() => setMode("divergence")}>
              Divergence
            </ModeButton>
          </div>
          <ZoomButtons
            onZoom={(f) => cameraRef.current && stepZoom(cameraRef.current, f)}
            onReset={() =>
              cameraRef.current &&
              homeRef.current &&
              resetFocus(cameraRef.current, homeRef.current)
            }
          />
          <DivergenceLegend mode={mode} />
        </>
      ) : (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-fg-muted">
          {phase === "loading"
            ? "Rendering…"
            : phase === "empty"
              ? "No gaze or click hit-points in range. Enable gaze + pointer capture in the SDK."
              : phase === "error"
                ? (error ?? "Overlay unavailable.")
                : null}
        </div>
      )}
    </div>
  );
}

/** Bottom-right legend distinguishing the gaze (cool) and click (warm) layers. */
function DivergenceLegend({ mode }: { mode: LayerMode }) {
  return (
    <div className="absolute bottom-3 right-3 max-w-72 rounded-md border border-edge bg-ink/80 px-2 py-1.5 text-xs text-fg backdrop-blur">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#38bdf8]" />
          {mode === "divergence" ? "Gaze-heavy" : "Gaze"}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#f4c84b]" />
          {mode === "divergence" ? "Click-heavy" : "Clicks"}
        </span>
      </div>
      <p className="mt-1 text-fg-muted">
        {mode === "divergence"
          ? "Per-voxel normalized difference: which signal dominates each cell. Color & size scale with the gap."
          : "Gaze = where viewers looked; Clicks = where they acted. Cells with gaze but no clicks are looked-at but un-acted-on."}
      </p>
    </div>
  );
}

/** Top-left segmented control button for the layer mode. */
function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 font-medium transition ${
        active ? "bg-amber text-ink" : "text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

/** Chrome-wrapped divergence overlay for legacy call sites. */
export function GazeClickDivergence3D(props: Parameters<typeof GazeClickDivergence3DView>[0]) {
  return (
    <Panel title={GAZE_CLICK_TITLE} subtitle={GAZE_CLICK_SUBTITLE}>
      <GazeClickDivergence3DView {...props} />
    </Panel>
  );
}
