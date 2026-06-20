"use client";

import { useEffect, useRef, useState } from "react";
import type { SceneProxyMesh, WorldHeatmapBin } from "@/lib/api";
import { heatRgb } from "@/lib/heat";
import { disableWheelZoom, stepZoom, type OrbitZoomCamera } from "@/lib/orbitZoom";
import { attachMeshHover, type HoverTip } from "@/lib/sceneHover";
import { HeatLegend } from "./HeatLegend";
import { Panel } from "./Panel";
import { ZoomButtons } from "./ZoomButtons";

type Phase = "loading" | "ready" | "empty" | "error";

/** Base mesh used to draw each populated voxel. */
type MarkerShape = "sphere" | "cube";

/**
 * World-space (3D) pointer heatmap. Renders each populated voxel as a marker
 * (sphere by default, cube optional), colored and sized by hit density, using
 * thin instances so thousands of voxels stay a single draw call. When a
 * registered scene proxy is supplied, its
 * per-mesh AABBs are drawn as a faint wireframe backdrop so hotspots read
 * against the developer's actual scene (ADR 0014). Babylon loads dynamically
 * (browser-only).
 */
export function WorldHeatmap3D({
  voxels,
  cellSize,
  proxyMeshes = [],
  title = "World heatmap (3D)",
  subtitle = "Pointer hit-points voxel-binned in world space — drag to orbit, +/- to zoom",
  legendTitle = "Pointer-hit density",
  legendLow = "few hits",
  legendHigh = "most hits",
  legendNote = "Each marker is a voxel where the pointer hit your scene. Color & size scale with hits, normalized to the busiest cell.",
  emptyLabel = "No 3D hit-points in range.",
}: {
  voxels: WorldHeatmapBin[];
  cellSize: number;
  proxyMeshes?: SceneProxyMesh[];
  title?: string;
  subtitle?: string;
  legendTitle?: string;
  legendLow?: string;
  legendHigh?: string;
  legendNote?: string;
  emptyLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<OrbitZoomCamera | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [markerShape, setMarkerShape] = useState<MarkerShape>("sphere");
  const [tip, setTip] = useState<HoverTip | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (voxels.length === 0 && proxyMeshes.length === 0) {
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
        ]);
        if (disposed) return;

        const maxCount = voxels.reduce((m, v) => Math.max(m, v.count), 1);

        // World-space bounds to frame the camera. Prefer voxel centers; fall
        // back to proxy AABB centers when there are no hit-points yet.
        let cx = 0;
        let cy = 0;
        let cz = 0;
        let samples = 0;
        for (const v of voxels) {
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
        for (const v of voxels) {
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
        new HemisphericLight("world-light", new Vector3(0.4, 1, 0.3), scene);

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
          // Per-instance hover labels so hovering a proxy box names the mesh (#123).
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

        if (voxels.length > 0) {
          // Spheres read as a soft thermal cloud; cubes show axis-aligned
          // occupancy. Both take the same per-instance matrices/colors.
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

          const n = voxels.length;
          const matrices = new Float32Array(n * 16);
          const colors = new Float32Array(n * 4);
          for (let i = 0; i < n; i++) {
            const v = voxels[i]!;
            const t = v.count / maxCount;
            // Scale each marker by intensity (min 35%) so hotspots read as larger.
            const s = 0.35 + 0.65 * t;
            const m = Matrix.Scaling(s, s, s).multiply(
              Matrix.Translation(
                (v.vx + 0.5) * cellSize,
                (v.vy + 0.5) * cellSize,
                (v.vz + 0.5) * cellSize,
              ),
            );
            m.copyToArray(matrices, i * 16);
            const [r, g, b] = heatRgb(t);
            colors[i * 4] = r;
            colors[i * 4 + 1] = g;
            colors[i * 4 + 2] = b;
            colors[i * 4 + 3] = 1;
          }
          marker.thinInstanceSetBuffer("matrix", matrices, 16, true);
          marker.thinInstanceSetBuffer("color", colors, 4, true);
        }

        engine.runRenderLoop(() => scene.render());
        const onResize = () => engine.resize();
        window.addEventListener("resize", onResize);
        const detachHover = attachMeshHover(scene, canvas, setTip);

        setPhase("ready");
        cleanup = () => {
          window.removeEventListener("resize", onResize);
          detachHover();
          setTip(null);
          cameraRef.current = null;
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
  }, [voxels, cellSize, proxyMeshes, markerShape]);

  return (
    <Panel title={title} subtitle={subtitle}>
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
            <ZoomButtons onZoom={(f) => cameraRef.current && stepZoom(cameraRef.current, f)} />
            <HeatLegend
              title={legendTitle}
              lowLabel={legendLow}
              highLabel={legendHigh}
              note={legendNote}
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
    </Panel>
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
