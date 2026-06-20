"use client";

import { useEffect, useRef, useState } from "react";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CollectorApi } from "@/lib/api";
import { disableWheelZoom, stepZoom, type OrbitZoomCamera } from "@/lib/orbitZoom";
import { useLiveSession, type LiveEvent } from "@/lib/live";
import { Panel } from "./Panel";
import { ZoomButtons } from "./ZoomButtons";

/** Fade window for a recently-arrived interaction ray. */
const TRAIL_MS = 2_600;

/**
 * Per-session live replay (ADR 0032 §4). Tails `/api/v1/live/sessions/:id` and
 * feeds each arriving event straight into a birdview `ReplayDriver` from
 * `@uptimizr/replay` — a live session is simply a replay whose stream has not
 * ended (ADR 0015 `afterTs` cursor). No scrubber: the view always follows the
 * live edge. Gated behind raw-session retention exactly like historical replay;
 * a `403` is surfaced as a disabled state rather than retried.
 *
 * Babylon is imported dynamically so it never runs during SSR and stays out of
 * the main dashboard chunk.
 */
export function LiveSessionReplay({
  baseUrl,
  apiKey,
  sessionId,
}: {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<OrbitZoomCamera | null>(null);
  // The live birdview driver, created once the Babylon scene is built. Live
  // events are applied through this; `reset()` clears it on reconnect.
  const driverRef = useRef<{ reset: () => void; apply: (event: LiveEvent) => void } | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const enabled = Boolean(baseUrl && apiKey && sessionId);

  const { status, gated, count } = useLiveSession(
    baseUrl,
    apiKey,
    sessionId,
    enabled && phase === "ready",
    (event) => driverRef.current?.apply(event),
    () => driverRef.current?.reset(),
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return;

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
          { Vector3, Color3, Color4 },
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
          // Side effect only: registers Babylon's `Ray` so `scene.pick()` (used by
          // the hover overlay) works. Deep imports tree-shake it out otherwise →
          // "Ray was not registered as a side effect". Not destructured.
          import("@babylonjs/core/Culling/ray.js"),
        ]);
        if (disposed) return;

        const engine = new Engine(canvas, true, { preserveDrawingBuffer: false });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

        const camera = new ArcRotateCamera(
          "live-cam",
          -Math.PI / 2,
          0.22,
          12,
          Vector3.Zero(),
          scene,
        );
        camera.attachControl(canvas, true);
        disableWheelZoom(camera);
        cameraRef.current = camera;
        new HemisphericLight("live-light", new Vector3(0, 1, 0), scene);

        const ground = MeshBuilder.CreateGround(
          "live-ground",
          { width: 20, height: 20, subdivisions: 20 },
          scene,
        );
        const gridMat = new StandardMaterial("live-ground-mat", scene);
        gridMat.diffuseColor = new Color3(0.12, 0.14, 0.18);
        gridMat.wireframe = true;
        ground.material = gridMat;

        // Current-camera marker + forward frustum line, moved on each camera_sample.
        const camMarker = MeshBuilder.CreateSphere(
          "live-cam-origin",
          { diameter: 0.35, segments: 8 },
          scene,
        );
        const camMarkerMat = new StandardMaterial("live-cam-origin-mat", scene);
        camMarkerMat.disableLighting = true;
        camMarkerMat.emissiveColor = new Color3(0.6, 0.9, 1);
        camMarker.material = camMarkerMat;
        camMarker.isVisible = false;

        let frustum = MeshBuilder.CreateLines(
          "live-frustum",
          { points: [Vector3.Zero(), new Vector3(0, 0, 1)] },
          scene,
        );
        frustum.color = new Color3(0.7, 0.95, 1);
        frustum.isPickable = false;

        // `CreateLineSystem` warns ("Setting vertex data kind 'position' with an
        // empty array") when handed zero lines, which happens every frame with no
        // active trail. Build only when there's geometry, disposing the previous
        // handle and keeping `null` otherwise.
        type LineSystem = ReturnType<typeof MeshBuilder.CreateLineSystem>;
        const rebuildTrail = (
          prev: LineSystem | null,
          lines: InstanceType<typeof Vector3>[][],
          colors: InstanceType<typeof Color4>[][],
        ): LineSystem | null => {
          prev?.dispose();
          if (lines.length === 0) return null;
          const mesh = MeshBuilder.CreateLineSystem(
            "live-trail",
            { lines, colors, useVertexAlpha: true },
            scene,
          );
          mesh.isPickable = false;
          return mesh;
        };
        let trail: LineSystem | null = null;

        // --- Birdview ReplayDriver state (ADR 0032 §4) ---------------------
        // Persistent live state mutated by driver.apply as events arrive.
        let latestCam: [number, number, number] | null = null;
        let latestDir: [number, number, number] = [0, 0, 1];
        const rays: { origin: Vector3; hit: Vector3; type: string; at: number }[] = [];
        let proxyLoaded = false;
        let framed = false;
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;

        const grow = (p: readonly number[]): void => {
          minX = Math.min(minX, p[0]!);
          minY = Math.min(minY, p[1]!);
          minZ = Math.min(minZ, p[2]!);
          maxX = Math.max(maxX, p[0]!);
          maxY = Math.max(maxY, p[1]!);
          maxZ = Math.max(maxZ, p[2]!);
        };

        // Frame the camera once enough geometry is known, then leave it to the
        // user so live updates never fight their orbit.
        const frameOnce = (): void => {
          if (framed || !Number.isFinite(minX)) return;
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          const cz = (minZ + maxZ) / 2;
          const dx = maxX - minX;
          const dy = maxY - minY;
          const dz = maxZ - minZ;
          const span = Math.sqrt(dx * dx + dy * dy + dz * dz);
          camera.setTarget(new Vector3(cx, cy, cz));
          camera.radius = Number.isFinite(span) ? Math.max(8, span * 1.4) : 12;
          framed = true;
        };

        // Lazily drop the registered scene proxy (ADR 0014) under the live view
        // the first time we learn the session's sceneId.
        const loadProxy = (sceneId: string): void => {
          if (proxyLoaded) return;
          proxyLoaded = true;
          void new CollectorApi(baseUrl, apiKey)
            .sceneRepresentation(sceneId)
            .then((rep) => {
              if (disposed || !rep?.proxy) return;
              for (const m of rep.proxy.meshes) {
                const a = m.aabb;
                const box = MeshBuilder.CreateBox(
                  `live-proxy-${m.name}`,
                  {
                    width: Math.max(a[3] - a[0], 1e-3),
                    height: Math.max(a[4] - a[1], 1e-3),
                    depth: Math.max(a[5] - a[2], 1e-3),
                  },
                  scene,
                );
                box.position = new Vector3((a[0] + a[3]) / 2, (a[1] + a[4]) / 2, (a[2] + a[5]) / 2);
                const mat = new StandardMaterial(`live-proxy-mat-${m.name}`, scene);
                mat.wireframe = true;
                mat.disableLighting = true;
                mat.emissiveColor = new Color3(0.32, 0.4, 0.52);
                mat.alpha = 0.35;
                box.material = mat;
                box.isPickable = false;
              }
            })
            .catch(() => {});
        };

        const driver = {
          reset(): void {
            latestCam = null;
            rays.length = 0;
            camMarker.isVisible = false;
          },
          apply(event: LiveEvent): void {
            const sceneId = typeof event.sceneId === "string" ? event.sceneId : undefined;
            if (sceneId) loadProxy(sceneId);

            if (event.type === "camera_sample") {
              const pos = event.position as number[] | undefined;
              const dir = event.direction as number[] | undefined;
              if (pos && dir) {
                latestCam = [pos[0]!, pos[1]!, pos[2]!];
                latestDir = [dir[0]!, dir[1]!, dir[2]!];
                grow(latestCam);
                frameOnce();
              }
              return;
            }
            if (event.type === "pointer_click") {
              const hit = event.hitPoint as number[] | undefined;
              const ray = event.ray as { origin?: number[] } | undefined;
              const origin = ray?.origin ?? latestCam;
              if (hit && origin) {
                rays.push({
                  origin: new Vector3(origin[0]!, origin[1]!, origin[2]!),
                  hit: new Vector3(hit[0]!, hit[1]!, hit[2]!),
                  type: "pointer_click",
                  at: performance.now(),
                });
                grow(hit);
              }
              return;
            }
            if (event.type === "mesh_interaction") {
              const point = event.point as number[] | undefined;
              if (point && latestCam) {
                rays.push({
                  origin: new Vector3(latestCam[0], latestCam[1], latestCam[2]),
                  hit: new Vector3(point[0]!, point[1]!, point[2]!),
                  type: "mesh_interaction",
                  at: performance.now(),
                });
                grow(point);
              }
            }
          },
        };
        driverRef.current = driver;

        engine.runRenderLoop(() => {
          const now = performance.now();
          // Current camera origin + forward direction.
          if (latestCam) {
            camMarker.isVisible = true;
            camMarker.position.set(latestCam[0], latestCam[1], latestCam[2]);
            frustum.dispose();
            const tip = new Vector3(
              latestCam[0] + latestDir[0] * 2,
              latestCam[1] + latestDir[1] * 2,
              latestCam[2] + latestDir[2] * 2,
            );
            frustum = MeshBuilder.CreateLines(
              "live-frustum",
              {
                points: [new Vector3(latestCam[0], latestCam[1], latestCam[2]), tip],
              },
              scene,
            );
            frustum.color = new Color3(0.7, 0.95, 1);
            frustum.isPickable = false;
          }

          // Fade out interaction rays over TRAIL_MS, dropping expired ones.
          while (rays.length > 0 && now - rays[0]!.at > TRAIL_MS) rays.shift();
          const lines: Vector3[][] = [];
          const colors: InstanceType<typeof Color4>[][] = [];
          for (const r of rays) {
            const t = 1 - (now - r.at) / TRAIL_MS;
            const c =
              r.type === "mesh_interaction"
                ? new Color4(0.45, 0.85, 1, 0.2 + 0.7 * t)
                : new Color4(1, 0.7, 0.35, 0.2 + 0.7 * t);
            lines.push([r.origin, r.hit]);
            colors.push([c, c]);
          }
          trail = rebuildTrail(trail, lines, colors);

          scene.render();
        });

        const onResize = () => engine.resize();
        window.addEventListener("resize", onResize);
        setPhase("ready");

        cleanup = () => {
          window.removeEventListener("resize", onResize);
          driverRef.current = null;
          frustum.dispose();
          trail?.dispose();
          scene.dispose();
          engine.dispose();
          cameraRef.current = null;
        };
      } catch (err) {
        if (disposed) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : "Failed to start live replay.");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [baseUrl, apiKey, sessionId, enabled]);

  const live = status === "open";
  const statusLabel = gated
    ? "Live follow disabled"
    : live
      ? "● LIVE"
      : status === "connecting"
        ? "connecting…"
        : status === "reconnecting"
          ? "reconnecting…"
          : "idle";

  return (
    <Panel
      title="Live replay"
      subtitle="Following this session in real time as events arrive."
      help={
        <>
          Tails the session&apos;s live event stream and re-drives it in a neutral birdview (camera
          origin + forward, fading interaction rays). This is the same replay stack used for
          historical sessions, tailing an open stream. Requires raw-session retention to be enabled
          on the collector.
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border border-edge px-2.5 py-1 font-medium ${
            live ? "text-emerald-300" : gated ? "text-amber-300" : "text-fg-muted"
          }`}
        >
          {statusLabel}
        </span>
        {!gated ? <span className="text-fg-muted">{count} events</span> : null}
      </div>

      {gated ? (
        <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          Live follow requires raw-session retention, which is disabled on this collector. Enable{" "}
          <code className="font-mono text-amber-100">ENABLE_RAW_SESSION_RETENTION</code> to follow
          sessions live.
        </p>
      ) : (
        <div className="relative">
          <canvas
            ref={canvasRef}
            className="aspect-video w-full rounded-lg border border-edge bg-ink"
          />
          <ZoomButtons onZoom={(f) => cameraRef.current && stepZoom(cameraRef.current, f)} />
          {phase === "loading" ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-fg-muted">
              Starting live replay…
            </div>
          ) : null}
          {phase === "error" ? (
            <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-red-300">
              {error}
            </div>
          ) : null}
          {phase === "ready" && status !== "open" && !gated && count === 0 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-fg-muted">
              Waiting for live events…
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
