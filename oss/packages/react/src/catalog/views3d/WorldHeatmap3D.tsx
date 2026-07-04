"use client";

import { useEffect, useRef, useState } from "react";
import type { SceneProxyMesh, WorldHeatmapBin } from "../../api";
import { heatRgb, percentileMax } from "../../heat";
import {
  attachDoubleClickFocus,
  disableWheelZoom,
  resetFocus,
  stepZoom,
  type OrbitFocusCamera,
  type OrbitHome,
} from "../lib/orbitZoom";
import { attachMeshHover, type HoverTip } from "../lib/sceneHover";
import { HeatLegend } from "../views/HeatLegend";
import { ZoomButtons } from "../views/ZoomButtons";

type Phase = "loading" | "ready" | "empty" | "error";

/** Base mesh used to draw each populated voxel. */
type MarkerShape = "sphere" | "cube";

/** Props shared by the body view and the chrome-wrapped legacy component. */
interface WorldHeatmap3DViewProps {
  voxels: WorldHeatmapBin[];
  cellSize: number;
  proxyMeshes?: SceneProxyMesh[];
  legendTitle?: string;
  legendLow?: string;
  legendHigh?: string;
  legendNote?: string;
  emptyLabel?: string;
  /**
   * Scene-wide totals (ADR 0040 §3). When the rendered voxels are a truncated
   * top-N slice, this lets the legend say "showing top N of M cells" so cold
   * spots and overall coverage aren't mistaken for the whole picture.
   */
  totals?: { cells: number; hits: number };
  /**
   * Optional per-voxel hover labels, indexed to match `voxels` (#145). When
   * supplied, each marker becomes pickable and hovering it shows the label — used
   * by the perf heatmap to surface the honest FPS behind each cell's heat, since
   * the heat channel there encodes "slowness" rather than a raw count. Omit it
   * (the default) for the pointer/gaze heatmaps, which stay non-pickable.
   */
  voxelLabels?: (string | null)[];
}

/**
 * World-space (3D) pointer heatmap — the panel BODY only (no chrome). Renders
 * each populated voxel as a marker (sphere by default, cube optional), colored
 * and sized by hit density, using thin instances so thousands of voxels stay a
 * single draw call. When a registered scene proxy is supplied, its per-mesh
 * AABBs are drawn as a faint wireframe backdrop so hotspots read against the
 * developer's actual scene (ADR 0014). Babylon loads dynamically (browser-only).
 *
 * The host supplies title/subtitle via the ADR 0036 panel contract (the OSS
 * catalog's `worldHeatmapPanel`, or a host wrapping this view in its own chrome).
 */
export function WorldHeatmap3DView({
  voxels,
  cellSize,
  proxyMeshes = [],
  legendTitle = "Pointer-hit density",
  legendLow = "few hits",
  legendHigh = "most hits",
  legendNote = "Each marker is a voxel where the pointer hit your scene. Color & size scale with hits, normalized to the 95th-percentile cell so a few hotspots don't wash out the rest.",
  emptyLabel = "No 3D hit-points in range.",
  totals,
  voxelLabels,
}: WorldHeatmap3DViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<OrbitFocusCamera | null>(null);
  const homeRef = useRef<OrbitHome | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [markerShape, setMarkerShape] = useState<MarkerShape>("sphere");
  const [tip, setTip] = useState<HoverTip | null>(null);

  // Latest data is read through refs so the heavy lifecycle effect (which builds
  // the engine and frames the camera) does NOT re-run when live data refreshes —
  // that teardown/rebuild is what made the panel flicker and snap the camera back
  // to its default. Instead a live refresh only repaints the instance buffers in
  // place (see the data effect below), leaving the engine and the user's camera
  // untouched.
  const voxelsRef = useRef(voxels);
  const proxyMeshesRef = useRef(proxyMeshes);
  const voxelLabelsRef = useRef(voxelLabels);
  voxelsRef.current = voxels;
  proxyMeshesRef.current = proxyMeshes;
  voxelLabelsRef.current = voxelLabels;

  // Imperative repaint installed by the lifecycle effect once the scene exists.
  // Called by the data effect on every data change to update the voxel markers
  // (and rebuild the proxy backdrop only when the scene geometry itself changed)
  // without recreating the engine or moving the camera.
  const syncRef = useRef<(() => void) | null>(null);

  // The scene only needs (re)building when there is something to show or when a
  // structural input changes (marker shape / cell size). Data churn keeps this
  // boolean stable, so the lifecycle effect stays put across live refreshes.
  const hasContent = voxels.length > 0 || proxyMeshes.length > 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!hasContent) {
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
          // Side-effect: registers Babylon's `Ray` so `scene.pick()` (hover
          // overlay) works; deep imports tree-shake it out otherwise.
          import("@babylonjs/core/Culling/ray.js"),
        ]);
        if (disposed) return;

        // Frame the camera from whatever data is present at build time. Prefer
        // voxel centers; fall back to proxy AABB centers when there are no
        // hit-points yet. This runs once per scene build, so subsequent live
        // data updates never reframe / reset the camera under the user.
        const voxels0 = voxelsRef.current;
        const proxy0 = proxyMeshesRef.current;
        let cx = 0;
        let cy = 0;
        let cz = 0;
        let samples = 0;
        for (const v of voxels0) {
          cx += (v.vx + 0.5) * cellSize;
          cy += (v.vy + 0.5) * cellSize;
          cz += (v.vz + 0.5) * cellSize;
          samples++;
        }
        if (samples === 0) {
          for (const m of proxy0) {
            cx += (m.aabb[0] + m.aabb[3]) / 2;
            cy += (m.aabb[1] + m.aabb[4]) / 2;
            cz += (m.aabb[2] + m.aabb[5]) / 2;
            samples++;
          }
        }
        const center = new Vector3(cx / samples, cy / samples, cz / samples);
        let radius = cellSize * 4;
        for (const v of voxels0) {
          const dx = (v.vx + 0.5) * cellSize - center.x;
          const dy = (v.vy + 0.5) * cellSize - center.y;
          const dz = (v.vz + 0.5) * cellSize - center.z;
          radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        for (const m of proxy0) {
          const dx = (m.aabb[0] + m.aabb[3]) / 2 - center.x;
          const dy = (m.aabb[1] + m.aabb[4]) / 2 - center.y;
          const dz = (m.aabb[2] + m.aabb[5]) / 2 - center.z;
          radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }

        const engine = new Engine(canvas, true, { preserveDrawingBuffer: false });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

        const camera = new ArcRotateCamera(
          "world-cam",
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
        new HemisphericLight("world-light", new Vector3(0.4, 1, 0.3), scene);

        // Size each marker relative to the SCENE, not the fixed voxel size, so
        // its on-screen footprint is consistent whether the scene is a small
        // viewer model or a large walkable level. Target ~2% of the scene
        // radius, floored to a quarter voxel so tiny scenes still show a clear
        // marker. `fitScale` converts that world size into an instance scale of
        // the `cellSize * 0.9` base mesh. Fixed at build time (scene-relative).
        const markerUnit = Math.max(radius * 0.02, cellSize * 0.25);
        const fitScale = markerUnit / (cellSize * 0.9);
        const baseRadius = camera.radius;

        // The single voxel marker mesh, created once. Spheres read as a soft
        // thermal cloud; cubes show axis-aligned occupancy. Both take the same
        // per-instance matrices/colors, updated in place by `syncVoxels`.
        const marker =
          markerShape === "cube"
            ? MeshBuilder.CreateBox("world-voxel", { size: cellSize * 0.9 }, scene)
            : MeshBuilder.CreateSphere(
                "world-voxel",
                { diameter: cellSize * 0.9, segments: 6 },
                scene,
              );
        const mat = new StandardMaterial("world-voxel-mat", scene);
        mat.diffuseColor = new Color3(1, 1, 1);
        mat.specularColor = new Color3(0, 0, 0);
        marker.material = mat;

        // Mutable per-instance state shared with the zoom observer so it always
        // scales the current voxel set (rewritten wholesale by `syncVoxels`).
        let instN = 0;
        let matrices = new Float32Array(0);
        let baseScales = new Float32Array(0);
        let lastZoom = -1;

        // Keep markers legible when zoomed out on large scenes: grow each marker
        // with the camera distance so its on-screen size stays roughly constant.
        // We only rewrite the scale diagonal of each instance matrix (translation
        // untouched), and only when the zoom changes meaningfully.
        const applyZoomScale = () => {
          if (instN === 0) return;
          const zoom = Math.min(8, Math.max(0.6, camera.radius / baseRadius));
          if (Math.abs(zoom - lastZoom) < 0.01) return;
          lastZoom = zoom;
          for (let i = 0; i < instN; i++) {
            const s = baseScales[i]! * zoom;
            const o = i * 16;
            matrices[o] = s;
            matrices[o + 5] = s;
            matrices[o + 10] = s;
          }
          marker.thinInstanceBufferUpdated("matrix");
        };
        scene.onBeforeRenderObservable.add(applyZoomScale);

        // Repaint the voxel markers from the latest data (color/size by density),
        // reusing the existing mesh. Called on every data refresh — cheap, and it
        // never touches the engine or camera.
        const syncVoxels = () => {
          const vs = voxelsRef.current;
          const labels = voxelLabelsRef.current;
          const n = vs.length;
          if (n === 0) {
            instN = 0;
            marker.isVisible = false;
            return;
          }
          // Robust normalization (ADR 0040 §2): scale color/size by the p95 of
          // hit counts rather than the global max, so a few hot voxels don't
          // crush the contrast of an otherwise busy scene.
          const scaleMax = percentileMax(
            vs.map((v) => v.count),
            0.95,
          );
          const nextMatrices = new Float32Array(n * 16);
          const colors = new Float32Array(n * 4);
          const nextBaseScales = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            const v = vs[i]!;
            const t = Math.min(1, v.count / scaleMax);
            // Intensity modulates each marker between 50% and 100% of its size
            // so hotspots read as larger without low cells vanishing.
            const s = fitScale * (0.5 + 0.5 * t);
            nextBaseScales[i] = s;
            const m = Matrix.Scaling(s, s, s).multiply(
              Matrix.Translation(
                (v.vx + 0.5) * cellSize,
                (v.vy + 0.5) * cellSize,
                (v.vz + 0.5) * cellSize,
              ),
            );
            m.copyToArray(nextMatrices, i * 16);
            const [r, g, b] = heatRgb(t);
            colors[i * 4] = r;
            colors[i * 4 + 1] = g;
            colors[i * 4 + 2] = b;
            colors[i * 4 + 3] = 1;
          }
          instN = n;
          matrices = nextMatrices;
          baseScales = nextBaseScales;
          marker.isVisible = true;
          // Per-voxel hover labels (#145): opt-in. When the host supplies labels
          // (the perf heatmap), make the markers pickable so hovering names the
          // cell's honest metric; otherwise they stay non-pickable.
          marker.isPickable = Boolean(labels);
          marker.thinInstanceEnablePicking = Boolean(labels);
          marker.metadata = labels ? { hoverLabels: labels } : null;
          marker.thinInstanceSetBuffer("matrix", matrices, 16, false);
          marker.thinInstanceSetBuffer("color", colors, 4, true);
          // Re-apply the current zoom factor on top of the fresh base scales.
          lastZoom = -1;
          applyZoomScale();
        };

        // Faint wireframe backdrop: one thin-instanced unit box per proxy AABB.
        // Rebuilt only when the scene geometry itself changes (tracked by a cheap
        // signature) so a live data refresh doesn't churn it.
        let proxyBox: ReturnType<typeof MeshBuilder.CreateBox> | null = null;
        let proxySig = "\u0000";
        const syncProxy = () => {
          const proxyNow = proxyMeshesRef.current;
          const sig = proxyNow.map((m) => `${m.name}:${m.aabb.join(",")}`).join("|");
          if (sig === proxySig) return;
          proxySig = sig;
          if (proxyBox) {
            proxyBox.dispose(false, true);
            proxyBox = null;
          }
          if (proxyNow.length === 0) return;
          proxyBox = MeshBuilder.CreateBox("scene-proxy", { size: 1 }, scene);
          const proxyMat = new StandardMaterial("scene-proxy-mat", scene);
          proxyMat.wireframe = true;
          proxyMat.disableLighting = true;
          proxyMat.emissiveColor = new Color3(0.32, 0.4, 0.52);
          proxyMat.alpha = 0.35;
          proxyBox.material = proxyMat;
          proxyBox.isPickable = true;
          proxyBox.thinInstanceEnablePicking = true;
          // Per-instance hover labels so hovering a proxy box names the mesh (#123).
          proxyBox.metadata = { hoverLabels: proxyNow.map((m) => m.name) };

          const pn = proxyNow.length;
          const proxyMatrices = new Float32Array(pn * 16);
          for (let i = 0; i < pn; i++) {
            const a = proxyNow[i]!.aabb;
            const sx = Math.max(a[3] - a[0], 1e-3);
            const sy = Math.max(a[4] - a[1], 1e-3);
            const sz = Math.max(a[5] - a[2], 1e-3);
            const m = Matrix.Scaling(sx, sy, sz).multiply(
              Matrix.Translation((a[0] + a[3]) / 2, (a[1] + a[4]) / 2, (a[2] + a[5]) / 2),
            );
            m.copyToArray(proxyMatrices, i * 16);
          }
          proxyBox.thinInstanceSetBuffer("matrix", proxyMatrices, 16, true);
        };

        const sync = () => {
          syncProxy();
          syncVoxels();
        };
        syncRef.current = sync;
        sync();

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
          syncRef.current = null;
          cameraRef.current = null;
          homeRef.current = null;
          scene.dispose();
          engine.dispose();
        };
      } catch (err) {
        if (disposed) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : "Failed to render heatmap.");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
    // Structural inputs only: the scene is rebuilt when the marker shape or cell
    // size changes, or when it first has something to show. Live `voxels` /
    // `proxyMeshes` / `voxelLabels` updates are applied in place by the effect
    // below without rebuilding — see `syncRef`.
  }, [markerShape, cellSize, hasContent]);

  // Repaint on every data change without recreating the engine or camera. When
  // the scene isn't built yet (initial async load) this is a no-op; the
  // lifecycle effect performs the first paint itself once ready.
  useEffect(() => {
    syncRef.current?.();
  }, [voxels, proxyMeshes, voxelLabels]);

  // ADR 0040 §3: when the voxel list is a truncated top-N slice, surface the true
  // totals so cold spots / overall coverage read correctly. Number truncation is
  // detected by comparing the rendered cells to the scene-wide occupied total.
  const coverageNote = totals
    ? totals.cells > voxels.length
      ? ` Showing the ${voxels.length.toLocaleString()} busiest of ${totals.cells.toLocaleString()} occupied cells (${totals.hits.toLocaleString()} total hits).`
      : ` ${totals.cells.toLocaleString()} occupied cells, ${totals.hits.toLocaleString()} total hits.`
    : "";

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        className="aspect-video w-full rounded-lg border border-edge bg-ink"
      />
      {tip ? (
        <div
          className="pointer-events-none absolute z-10 max-w-[16rem] truncate rounded border border-edge bg-ink/90 px-1.5 py-0.5 text-xs text-white shadow backdrop-blur"
          style={{ left: tip.x + 12, top: tip.y + 12 }}
        >
          {tip.label}
        </div>
      ) : null}
      {phase === "ready" ? (
        <>
          <MarkerShapeToggle shape={markerShape} onChange={setMarkerShape} />
          <ZoomButtons
            onZoom={(f) => cameraRef.current && stepZoom(cameraRef.current, f)}
            onReset={() =>
              cameraRef.current && homeRef.current && resetFocus(cameraRef.current, homeRef.current)
            }
          />
          <HeatLegend
            title={legendTitle}
            lowLabel={legendLow}
            highLabel={legendHigh}
            note={legendNote + coverageNote}
          />
        </>
      ) : (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-fg-muted">
          {phase === "loading"
            ? "Rendering…"
            : phase === "empty"
              ? emptyLabel
              : phase === "error"
                ? (error ?? "Heatmap unavailable.")
                : null}
        </div>
      )}
    </div>
  );
}

/** Top-left segmented control to switch the voxel marker between spheres and cubes. */
function MarkerShapeToggle({
  shape,
  onChange,
}: {
  shape: MarkerShape;
  onChange: (shape: MarkerShape) => void;
}) {
  const base =
    "h-8 px-2.5 text-xs font-medium leading-none transition first:rounded-l-md last:rounded-r-md";
  const cls = (active: boolean) =>
    `${base} ${active ? "bg-ink text-white" : "bg-ink/80 text-fg hover:text-white"}`;
  const sphereActive = shape === "sphere";
  const cubeActive = shape === "cube";
  return (
    <div
      className="absolute left-3 top-3 flex overflow-hidden rounded-md border border-edge backdrop-blur"
      role="group"
      aria-label="Voxel marker shape"
    >
      <button
        type="button"
        className={cls(sphereActive)}
        aria-pressed={sphereActive}
        onClick={() => onChange("sphere")}
      >
        Spheres
      </button>
      <button
        type="button"
        className={cls(cubeActive)}
        aria-pressed={cubeActive}
        onClick={() => onChange("cube")}
      >
        Cubes
      </button>
    </div>
  );
}
