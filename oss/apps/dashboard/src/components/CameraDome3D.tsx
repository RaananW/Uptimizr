"use client";

import { useEffect, useRef, useState } from "react";
import { buildGazeEquirect } from "@uptimizr/heatmap";
import type { DirectionBin } from "@/lib/api";
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
type DomeMode = "markers" | "skydome";

/**
 * 3D view-direction ("gaze") dome. The camera-direction heatmap is spherical by
 * nature — each sample is a look-direction — so this maps every populated
 * azimuth/elevation bin onto the surface of a unit sphere as a marker, colored
 * and sized by how often that direction was viewed. It's the 3D companion to the
 * flat polar `CameraDirectionHeatmap`: orbit the dome to read the distribution
 * the way the audience actually looked around. Babylon loads dynamically
 * (browser-only).
 */
export function CameraDome3DView({ bins, gridSize }: { bins: DirectionBin[]; gridSize: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<OrbitFocusCamera | null>(null);
  const homeRef = useRef<OrbitHome | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DomeMode>("markers");
  const [tip, setTip] = useState<HoverTip | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (bins.length === 0) {
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
          { Mesh },
          { DynamicTexture },
        ] = await Promise.all([
          import("@babylonjs/core/Engines/engine.js"),
          import("@babylonjs/core/scene.js"),
          import("@babylonjs/core/Cameras/arcRotateCamera.js"),
          import("@babylonjs/core/Lights/hemisphericLight.js"),
          import("@babylonjs/core/Maths/math.js"),
          import("@babylonjs/core/Meshes/meshBuilder.js"),
          import("@babylonjs/core/Materials/standardMaterial.js"),
          import("@babylonjs/core/Meshes/mesh.js"),
          import("@babylonjs/core/Materials/Textures/dynamicTexture.js"),
          // Side-effect: augments Mesh.prototype with thinInstance* methods.
          import("@babylonjs/core/Meshes/thinInstanceMesh.js"),
          // Side-effect: registers Babylon's `Ray` so `scene.pick()` (hover
          // overlay) works; deep imports tree-shake it out otherwise.
          import("@babylonjs/core/Culling/ray.js"),
        ]);
        if (disposed) return;

        const engine = new Engine(canvas, true, { preserveDrawingBuffer: false });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

        const domeCenter = Vector3.Zero();
        const camera = new ArcRotateCamera(
          "dome-cam",
          Math.PI / 3,
          Math.PI / 2.4,
          3.6,
          domeCenter,
          scene,
        );
        camera.attachControl(canvas, true);
        camera.lowerRadiusLimit = 1.6;
        camera.upperRadiusLimit = 8;
        disableWheelZoom(camera);
        cameraRef.current = camera;
        homeRef.current = {
          target: domeCenter,
          alpha: camera.alpha,
          beta: camera.beta,
          radius: camera.radius,
        };
        new HemisphericLight("dome-light", new Vector3(0.3, 1, 0.2), scene);

        // Reference dome (faint wireframe) so directions read as "on a sphere".
        const dome = MeshBuilder.CreateSphere("dome", { diameter: 2, segments: 20 }, scene);
        const domeMat = new StandardMaterial("dome-mat", scene);
        domeMat.wireframe = true;
        domeMat.disableLighting = true;
        domeMat.emissiveColor = new Color3(0.16, 0.2, 0.28);
        domeMat.alpha = 0.5;
        dome.material = domeMat;
        dome.isPickable = false;

        // Horizon ring (elevation 0) and a forward indicator (azimuth 0, +X).
        const horizonPts = [] as InstanceType<typeof Vector3>[];
        const ringSeg = 64;
        for (let i = 0; i <= ringSeg; i++) {
          const a = (i / ringSeg) * Math.PI * 2;
          horizonPts.push(new Vector3(Math.cos(a), 0, Math.sin(a)));
        }
        const horizon = MeshBuilder.CreateLines("dome-horizon", { points: horizonPts }, scene);
        horizon.color = new Color3(0.3, 0.36, 0.46);
        horizon.isPickable = false;

        const forward = MeshBuilder.CreateLines(
          "dome-forward",
          { points: [Vector3.Zero(), new Vector3(1.25, 0, 0)] },
          scene,
        );
        forward.color = new Color3(0.4, 0.7, 0.95);
        forward.isPickable = false;

        // Direction markers: one thin-instanced unit box per populated bin, sat
        // on the sphere surface at its reconstructed look-direction.
        const max = bins.reduce((m, b) => Math.max(m, b.count), 1);
        const safeGridSize = gridSize > 0 ? gridSize : 1;

        if (mode === "markers") {
          const box = MeshBuilder.CreateBox("dome-marker", { size: 1 }, scene);
          const markerMat = new StandardMaterial("dome-marker-mat", scene);
          markerMat.disableLighting = true;
          markerMat.emissiveColor = Color3.White();
          markerMat.specularColor = new Color3(0, 0, 0);
          box.material = markerMat;
          box.isPickable = true;
          box.thinInstanceEnablePicking = true;

          const n = bins.length;
          const matrices = new Float32Array(n * 16);
          const colors = new Float32Array(n * 4);
          // Dome bins are look-directions, not meshes; the hover affordance names
          // the direction bin + its view count so it stays consistent (#123).
          const labels: string[] = new Array(n);
          for (let i = 0; i < n; i++) {
            const b = bins[i]!;
            // Invert the binning the camera query applied (see clickhouse/queries).
            const az = ((b.azimuth_bin + 0.5) / safeGridSize) * Math.PI * 2 - Math.PI;
            const el = ((b.elevation_bin + 0.5) / safeGridSize) * Math.PI - Math.PI / 2;
            const ce = Math.cos(el);
            const dx = ce * Math.cos(az);
            const dy = Math.sin(el);
            const dz = ce * Math.sin(az);
            const t = b.count / max;
            const s = 0.03 + 0.12 * t;
            const m = Matrix.Scaling(s, s, s).multiply(Matrix.Translation(dx, dy, dz));
            m.copyToArray(matrices, i * 16);
            const [r, g, bl] = heatRgb(t);
            colors[i * 4] = r;
            colors[i * 4 + 1] = g;
            colors[i * 4 + 2] = bl;
            colors[i * 4 + 3] = 1;
            labels[i] = `dir (${b.azimuth_bin}, ${b.elevation_bin}) · ${b.count}`;
          }
          box.thinInstanceSetBuffer("matrix", matrices, 16, true);
          box.thinInstanceSetBuffer("color", colors, 4, true);
          box.metadata = { hoverLabels: labels };
        } else {
          // Skydome: splat the same bins into a continuous equirectangular heat
          // texture (shared engine-free core from @uptimizr/heatmap) and wrap it
          // on a globe so the distribution reads as a smooth field rather than
          // discrete markers. Orbit from outside; the §7.6 dev overlay
          // (`showGazeSkydome`) is the inward, stand-inside form for WebXR.
          const equirect = buildGazeEquirect(
            {
              bins: bins.map((b) => ({
                azimuthBin: b.azimuth_bin,
                elevationBin: b.elevation_bin,
                count: b.count,
              })),
              gridSize: safeGridSize,
            },
            { width: 256, blurBins: 1.5, opacity: 0.95 },
          );
          const tex = new DynamicTexture(
            "dome-skytex",
            { width: equirect.width, height: equirect.height },
            scene,
            false,
          );
          tex.hasAlpha = true;
          const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
          const image = ctx.createImageData(equirect.width, equirect.height);
          image.data.set(equirect.rgba);
          ctx.putImageData(image, 0, 0);
          tex.update();

          const globe = MeshBuilder.CreateSphere(
            "dome-sky",
            { diameter: 2, segments: 48, sideOrientation: Mesh.DOUBLESIDE },
            scene,
          );
          const skyMat = new StandardMaterial("dome-sky-mat", scene);
          skyMat.disableLighting = true;
          skyMat.emissiveColor = Color3.White();
          skyMat.diffuseColor = new Color3(0, 0, 0);
          skyMat.specularColor = new Color3(0, 0, 0);
          skyMat.emissiveTexture = tex;
          skyMat.opacityTexture = tex;
          skyMat.backFaceCulling = false;
          globe.material = skyMat;
          globe.isPickable = false;
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
        setError(err instanceof Error ? err.message : "Failed to render dome.");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [bins, gridSize, mode]);

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
          <div className="absolute left-3 top-3 flex overflow-hidden rounded-md border border-edge bg-ink/80 text-xs backdrop-blur">
            {(["markers", "skydome"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-2.5 py-1 ${
                  mode === m ? "bg-fg/15 font-medium text-white" : "text-fg-muted hover:text-fg"
                }`}
              >
                {m === "markers" ? "Markers" : "Skydome"}
              </button>
            ))}
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
            title="Gaze density"
            lowLabel="rarely"
            highLabel="most-viewed"
            note={
              mode === "markers"
                ? "Each marker is a look-direction (camera forward). Blue line = forward, ring = horizon. Color & size scale with how often that direction was viewed."
                : "Continuous equirectangular heat field: the same gaze bins splatted into a smooth thermal texture wrapped on the dome. The in-scene SDK overlay (showGazeSkydome) renders this inward so you can stand inside it in WebXR."
            }
          />
        </>
      ) : (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-fg-muted">
          {phase === "loading"
            ? "Rendering…"
            : phase === "empty"
              ? "No camera samples in range."
              : phase === "error"
                ? (error ?? "Dome unavailable.")
                : null}
        </div>
      )}
    </div>
  );
}

export const CAMERA_DOME_TITLE = "View-direction dome (3D)";
export const CAMERA_DOME_SUBTITLE =
  "Where the audience looked, mapped onto a sphere — drag to orbit, +/- to zoom, double-click to focus";

/** Chrome-wrapped dome for legacy call sites (overview + session surfaces). */
export function CameraDome3D(props: { bins: DirectionBin[]; gridSize: number }) {
  return (
    <Panel title={CAMERA_DOME_TITLE} subtitle={CAMERA_DOME_SUBTITLE}>
      <CameraDome3DView {...props} />
    </Panel>
  );
}
