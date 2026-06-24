"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ClickRay, SceneProxyMesh } from "@/lib/api";
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
import { HeatLegend } from "./HeatLegend";
import { Panel } from "./Panel";
import { ZoomButtons } from "./ZoomButtons";

type Phase = "loading" | "ready" | "empty" | "error";

/** Sentinel select value meaning "no filter applied". */
const ALL = "__all__";

/** A distinct camera-origin voxel a viewer clicked from (the view-gate buckets). */
interface Viewpoint {
  key: string;
  voxel: [number, number, number];
  count: number;
}

function voxelKey(v: readonly [number, number, number]): string {
  return `${v[0]},${v[1]},${v[2]}`;
}

/**
 * View-gated click rays (design §7.2) and per-mesh incoming-direction rose
 * (design §7.3). Each ray connects the camera-origin voxel a click was made
 * from to the world-space hit point, correlated server-side by ASOF-joining
 * every `pointer_click` to its nearest preceding `camera_sample`.
 *
 * Picking a viewpoint gates the scene to only the rays cast from that camera
 * voxel ("what did people look at from here?"). Picking a mesh draws a rose at
 * the mesh centroid whose spokes point back toward the viewpoints its clicks
 * came from, with spoke length/color scaled by click volume ("where were people
 * standing when they clicked this?"). Babylon loads dynamically (browser-only).
 */
export function ClickRays3D({
  rays,
  cellSize,
  proxyMeshes = [],
}: {
  rays: ClickRay[];
  cellSize: number;
  proxyMeshes?: SceneProxyMesh[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<OrbitFocusCamera | null>(null);
  const homeRef = useRef<OrbitHome | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string>(ALL);
  const [meshFocus, setMeshFocus] = useState<string>(ALL);
  const [tip, setTip] = useState<HoverTip | null>(null);

  // Distinct camera-origin voxels (view-gate buckets), busiest first.
  const viewpoints = useMemo<Viewpoint[]>(() => {
    const byKey = new Map<string, Viewpoint>();
    for (const ray of rays) {
      const key = voxelKey(ray.camVoxel);
      const cur = byKey.get(key);
      if (cur) cur.count += ray.count;
      else byKey.set(key, { key, voxel: ray.camVoxel, count: ray.count });
    }
    return [...byKey.values()].sort((a, b) => b.count - a.count);
  }, [rays]);

  // Distinct clicked meshes (rose targets), busiest first.
  const meshes = useMemo<{ name: string; count: number }[]>(() => {
    const byName = new Map<string, number>();
    for (const ray of rays) {
      if (ray.mesh === "") continue;
      byName.set(ray.mesh, (byName.get(ray.mesh) ?? 0) + ray.count);
    }
    return [...byName.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [rays]);

  // Keep filters valid when global time/scene/session filters change.
  useEffect(() => {
    if (focusKey === ALL) return;
    if (!viewpoints.some((v) => v.key === focusKey)) {
      setFocusKey(ALL);
    }
  }, [focusKey, viewpoints]);

  useEffect(() => {
    if (meshFocus === ALL) return;
    if (!meshes.some((m) => m.name === meshFocus)) {
      setMeshFocus(ALL);
    }
  }, [meshFocus, meshes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (rays.length === 0) {
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

        // Apply the view-gate: keep only rays from the focused camera voxel.
        const visibleRays =
          focusKey === ALL ? rays : rays.filter((r) => voxelKey(r.camVoxel) === focusKey);
        if (visibleRays.length === 0) {
          setPhase("empty");
          return;
        }
        const maxCount = visibleRays.reduce((m, r) => Math.max(m, r.count), 1);

        // Frame the camera around every visible endpoint.
        let cx = 0;
        let cy = 0;
        let cz = 0;
        let samples = 0;
        const accumulate = (x: number, y: number, z: number) => {
          cx += x;
          cy += y;
          cz += z;
          samples++;
        };
        for (const r of visibleRays) {
          accumulate(r.origin[0], r.origin[1], r.origin[2]);
          accumulate(r.hit[0], r.hit[1], r.hit[2]);
        }
        const center =
          samples > 0 ? new Vector3(cx / samples, cy / samples, cz / samples) : Vector3.Zero();
        let radius = cellSize * 4;
        for (const r of visibleRays) {
          for (const p of [r.origin, r.hit]) {
            const dx = p[0] - center.x;
            const dy = p[1] - center.y;
            const dz = p[2] - center.z;
            radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
          }
        }

        const engine = new Engine(canvas, true, { preserveDrawingBuffer: false });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

        const camera = new ArcRotateCamera(
          "rays-cam",
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
        new HemisphericLight("rays-light", new Vector3(0.4, 1, 0.3), scene);

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
          // Per-instance hover labels so a viewer can name the proxy mesh a ray
          // landed near (#123). Indexed by `pickInfo.thinInstanceIndex`.
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

        // Click rays: one colored line origin → hit, shaded by click volume.
        const lines: InstanceType<typeof Vector3>[][] = [];
        const lineColors: InstanceType<typeof Color4>[][] = [];
        for (const r of visibleRays) {
          const t = r.count / maxCount;
          const [cr, cg, cb] = heatRgb(t);
          const color = new Color4(cr, cg, cb, 0.35 + 0.65 * t);
          lines.push([
            new Vector3(r.origin[0], r.origin[1], r.origin[2]),
            new Vector3(r.hit[0], r.hit[1], r.hit[2]),
          ]);
          lineColors.push([color, color]);
        }
        // Skip the line system entirely when there are no rays in range —
        // CreateLineSystem with an empty `lines` array builds a mesh with empty
        // position data, which Babylon warns about ("empty array").
        if (lines.length > 0) {
          const rayLines = MeshBuilder.CreateLineSystem(
            "click-rays",
            { lines, colors: lineColors, useVertexAlpha: true },
            scene,
          );
          rayLines.isPickable = false;
        }

        // Viewpoint markers: a small "eye" sphere at each visible camera voxel.
        const seenVoxels = new Map<string, [number, number, number]>();
        for (const r of visibleRays) seenVoxels.set(voxelKey(r.camVoxel), r.camVoxel);
        if (seenVoxels.size > 0) {
          const eye = MeshBuilder.CreateSphere(
            "rays-eye",
            { diameter: cellSize * 0.6, segments: 6 },
            scene,
          );
          const eyeMat = new StandardMaterial("rays-eye-mat", scene);
          eyeMat.disableLighting = true;
          eyeMat.emissiveColor = new Color3(0.9, 0.95, 1);
          eye.material = eyeMat;
          const voxelList = [...seenVoxels.values()];
          const eyeMatrices = new Float32Array(voxelList.length * 16);
          for (let i = 0; i < voxelList.length; i++) {
            const v = voxelList[i]!;
            Matrix.Translation(
              (v[0] + 0.5) * cellSize,
              (v[1] + 0.5) * cellSize,
              (v[2] + 0.5) * cellSize,
            ).copyToArray(eyeMatrices, i * 16);
          }
          eye.thinInstanceSetBuffer("matrix", eyeMatrices, 16, true);
        }

        // Per-mesh incoming-direction rose (§7.3): spokes from the mesh centroid
        // pointing back toward the viewpoints its clicks came from.
        if (meshFocus !== ALL) {
          const meshRays = rays.filter((r) => r.mesh === meshFocus);
          if (meshRays.length > 0) {
            const proxy = proxyMeshes.find((m) => m.name === meshFocus);
            let centroid: InstanceType<typeof Vector3>;
            if (proxy) {
              const a = proxy.aabb;
              centroid = new Vector3((a[0] + a[3]) / 2, (a[1] + a[4]) / 2, (a[2] + a[5]) / 2);
            } else {
              let hx = 0;
              let hy = 0;
              let hz = 0;
              for (const r of meshRays) {
                hx += r.hit[0];
                hy += r.hit[1];
                hz += r.hit[2];
              }
              centroid = new Vector3(
                hx / meshRays.length,
                hy / meshRays.length,
                hz / meshRays.length,
              );
            }
            const roseRadius = Math.max(cellSize * 3, radius * 0.18);
            const roseMax = meshRays.reduce((m, r) => Math.max(m, r.count), 1);
            const roseLines: InstanceType<typeof Vector3>[][] = [];
            const roseColors: InstanceType<typeof Color4>[][] = [];
            for (const r of meshRays) {
              // Incoming direction: from the hit point back toward the viewer.
              const dx = r.origin[0] - r.hit[0];
              const dy = r.origin[1] - r.hit[1];
              const dz = r.origin[2] - r.hit[2];
              const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
              const t = r.count / roseMax;
              const reach = roseRadius * (0.4 + 0.6 * t);
              const tip = new Vector3(
                centroid.x + (dx / len) * reach,
                centroid.y + (dy / len) * reach,
                centroid.z + (dz / len) * reach,
              );
              const [cr, cg, cb] = heatRgb(t);
              const color = new Color4(cr, cg, cb, 1);
              roseLines.push([centroid.clone(), tip]);
              roseColors.push([new Color4(cr, cg, cb, 0.25), color]);
            }
            const rose = MeshBuilder.CreateLineSystem(
              "mesh-rose",
              { lines: roseLines, colors: roseColors, useVertexAlpha: true },
              scene,
            );
            rose.isPickable = false;

            const hub = MeshBuilder.CreateSphere(
              "mesh-rose-hub",
              { diameter: cellSize * 0.8, segments: 8 },
              scene,
            );
            const hubMat = new StandardMaterial("mesh-rose-hub-mat", scene);
            hubMat.disableLighting = true;
            hubMat.emissiveColor = new Color3(1, 0.85, 0.4);
            hub.material = hubMat;
            hub.position = centroid;
            hub.isPickable = true;
            hub.metadata = { hoverLabel: meshFocus };
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
        setError(err instanceof Error ? err.message : "Failed to render click rays.");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [rays, cellSize, proxyMeshes, focusKey, meshFocus]);

  return (
    <Panel
      title="Click rays (3D)"
      subtitle="Each click joined to the view it was made from — gate by viewpoint or focus a mesh; double-click to recenter"
    >
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
            <div className="absolute left-3 top-3 flex gap-2">
              <RaysSelect
                label="Viewpoint"
                value={focusKey}
                onChange={setFocusKey}
                allLabel="All viewpoints"
                options={viewpoints.map((v) => ({
                  value: v.key,
                  label: `(${v.voxel.join(", ")}) · ${v.count}`,
                }))}
              />
              <RaysSelect
                label="Mesh rose"
                value={meshFocus}
                onChange={setMeshFocus}
                allLabel="No mesh focus"
                options={meshes.map((m) => ({ value: m.name, label: `${m.name} · ${m.count}` }))}
              />
            </div>
            <ZoomButtons
              onZoom={(f) => cameraRef.current && stepZoom(cameraRef.current, f)}
              onReset={() =>
                cameraRef.current &&
                homeRef.current &&
                resetFocus(cameraRef.current, homeRef.current)
              }
            />
            <HeatLegend
              title="Click volume"
              lowLabel="few clicks"
              highLabel="most clicks"
              note="Lines run from the camera position (bright eye) to where the click landed. Pick a viewpoint to see only clicks made from there; pick a mesh to see which directions its clicks came from."
            />
          </>
        ) : (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-fg-muted">
            {phase === "loading"
              ? "Rendering…"
              : phase === "empty"
                ? "No correlated clicks in range."
                : phase === "error"
                  ? (error ?? "Click rays unavailable.")
                  : null}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Compact labelled dropdown used for the viewpoint and mesh-rose gates. */
function RaysSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1.5 rounded-md border border-edge bg-ink/80 px-2 py-1 text-xs text-fg backdrop-blur">
      <span className="font-medium text-fg-muted">{label}</span>
      <select
        className="max-w-[12rem] bg-transparent text-white outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value={ALL}>{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
