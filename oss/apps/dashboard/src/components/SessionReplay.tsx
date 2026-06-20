"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CollectorApi } from "@/lib/api";
import { disableWheelZoom, stepZoom, type OrbitZoomCamera } from "@/lib/orbitZoom";
import { Panel } from "./Panel";
import { ZoomButtons } from "./ZoomButtons";

type Phase = "idle" | "loading" | "ready" | "empty" | "error";

/** Fade window for recently-fired interaction rays in birdview replay. */
const TRAIL_MS = 2200;

/** Window around the playhead in which an event "glows" (bright pulse). */
const GLOW_MS = 900;

/** Shared empty set so a missing `hiddenTypes` prop is referentially stable. */
const EMPTY_HIDDEN: ReadonlySet<string> = new Set<string>();

interface CameraSample {
  at: number;
  position: [number, number, number];
  direction: [number, number, number];
}

interface InteractionRay {
  at: number;
  /** Source event type (`pointer_click` | `mesh_interaction`) for per-type filtering. */
  type: string;
  origin: [number, number, number];
  hit: [number, number, number];
}

/** A timestamped world-space position of a tracked scene actor (`node_transform`). */
interface ActorSample {
  at: number;
  position: [number, number, number];
}

/** A single lane in the event-timeline overview: a named, color-coded channel. */
interface TimelineLane {
  key: string;
  label: string;
  color: string;
  /** Event positions as fractions of the session duration, in `[0, 1]`. */
  marks: number[];
}

/**
 * Event categories shown as stacked, color-coded lanes beneath the scrubber.
 * Order is top-to-bottom; the first lane whose `types` contains an event wins, so
 * sparse, high-signal channels (clicks) are listed before dense ones (pointer).
 */
const TIMELINE_LANES: ReadonlyArray<{
  key: string;
  label: string;
  color: string;
  types: ReadonlySet<string>;
}> = [
  {
    key: "interaction",
    label: "Clicks & picks",
    color: "#fb923c",
    types: new Set(["pointer_click", "mesh_interaction"]),
  },
  {
    key: "actors",
    label: "Scene actors",
    color: "#e879f9",
    types: new Set(["node_transform"]),
  },
  { key: "custom", label: "Custom", color: "#34d399", types: new Set(["custom"]) },
  { key: "camera", label: "Camera", color: "#38bdf8", types: new Set(["camera_sample"]) },
  {
    key: "pointer",
    label: "Pointer",
    color: "#94a3b8",
    types: new Set(["pointer_move", "pointer_down", "pointer_up"]),
  },
  { key: "perf", label: "Perf", color: "#a78bfa", types: new Set(["frame_perf"]) },
  {
    key: "lifecycle",
    label: "Lifecycle",
    color: "#f472b6",
    types: new Set([
      "session_start",
      "session_end",
      "scene_change",
      "focus_change",
      "visibility_change",
      "viewport_resize",
      "context_lost",
      "context_restored",
      "runtime_error",
      "capability_change",
      "input_action",
      "resource_sample",
      "compile_stall",
      "mesh_visibility",
      "hover_dwell",
    ]),
  },
];

/**
 * Bucket the event stream into the {@link TIMELINE_LANES} for the overview strip.
 * Positions are deduped per lane at a fixed resolution so dense channels
 * (camera/pointer/perf at 10s of Hz) never render thousands of DOM nodes.
 */
function buildTimeline(
  events: ReadonlyArray<{ type: string; ts: number }>,
  baseTs: number,
  durationMs: number,
): TimelineLane[] {
  const span = Math.max(1, durationMs);
  const RESOLUTION = 600;
  const laneOf = new Map<string, number>();
  TIMELINE_LANES.forEach((lane, i) => {
    for (const t of lane.types) laneOf.set(t, i);
  });
  const seen = TIMELINE_LANES.map(() => new Set<number>());
  for (const e of events) {
    const idx = laneOf.get(e.type);
    if (idx === undefined) continue;
    const frac = Math.min(1, Math.max(0, (e.ts - baseTs) / span));
    seen[idx]!.add(Math.round(frac * RESOLUTION));
  }
  return TIMELINE_LANES.map((lane, i) => ({
    key: lane.key,
    label: lane.label,
    color: lane.color,
    marks: [...seen[i]!].sort((a, b) => a - b).map((b) => b / RESOLUTION),
  })).filter((lane) => lane.marks.length > 0);
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Color-coded event-timeline overview rendered beneath the scrubber. Each lane is
 * a channel of events; ticks mark when events fired. The whole strip is
 * click-to-seek and shows a shared playhead synced to the scrubber.
 */
function EventTimeline({
  lanes,
  duration,
  progress,
  onSeek,
  hiddenTypes,
}: {
  lanes: TimelineLane[];
  duration: number;
  progress: number;
  onSeek: (ms: number) => void;
  hiddenTypes: ReadonlySet<string>;
}) {
  // A lane is shown while at least one of its member event types is still visible.
  const visibleLanes = lanes.filter((lane) => {
    const cfg = TIMELINE_LANES.find((l) => l.key === lane.key);
    if (!cfg) return true;
    for (const t of cfg.types) if (!hiddenTypes.has(t)) return true;
    return false;
  });
  if (visibleLanes.length === 0) return null;
  const playheadPct = `${Math.min(100, Math.max(0, (progress / Math.max(1, duration)) * 100))}%`;
  const seekFromClient = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / (rect.width || 1)));
    onSeek(frac * duration);
  };
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-fg-muted">
        {visibleLanes.map((lane) => (
          <span key={lane.key} className="inline-flex items-center gap-1">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: lane.color }}
            />
            {lane.label}
            <span className="tabular-nums text-fg-muted">({lane.marks.length})</span>
          </span>
        ))}
      </div>
      <button
        type="button"
        aria-label="Event timeline — click to seek"
        className="relative block w-full cursor-pointer select-none rounded-md border border-edge bg-ink/60 p-1.5 text-left"
        onClick={(e) => seekFromClient(e.clientX, e.currentTarget)}
      >
        <div className="flex flex-col gap-1">
          {visibleLanes.map((lane) => (
            <div key={lane.key} className="relative h-2.5 rounded-sm bg-white/5">
              {lane.marks.map((m, i) => (
                <span
                  key={i}
                  aria-hidden
                  className="pointer-events-none absolute top-0 h-full w-px"
                  style={{ left: `${m * 100}%`, backgroundColor: lane.color, opacity: 0.85 }}
                />
              ))}
            </div>
          ))}
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-1 w-px bg-saffron"
          style={{ left: playheadPct }}
        />
      </button>
    </div>
  );
}

/**
 * Per-session replay scrubber. Loads the captured event stream and re-drives a
 * birdview timeline overlay in a neutral reference scene (grid + axes): current
 * camera origin/forward plus recent origin→hit interaction rays.
 *
 * Babylon is imported dynamically so it never runs during SSR and stays out of
 * the main dashboard chunk.
 */
export function SessionReplay({
  baseUrl,
  apiKey,
  sessionId,
  hiddenTypes,
}: {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  /** Event types to hide from the 3D overlay + timeline (driven by the inspector). */
  hiddenTypes?: ReadonlySet<string>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<OrbitZoomCamera | null>(null);
  const progressRef = useRef(0);
  const hiddenRef = useRef<ReadonlySet<string>>(hiddenTypes ?? EMPTY_HIDDEN);
  const dirtyRef = useRef(false);
  const playerRef = useRef<{
    play: () => void;
    pause: () => void;
    seek: (ms: number) => void;
  } | null>(null);
  // Proxy-mesh AABB labels: their world-space box centers (set on scene build),
  // the DOM nodes that float over the canvas, and a ref-mirrored visibility flag
  // so the per-frame projection loop can short-circuit without a React re-render.
  const labelCentersRef = useRef<{ name: string; center: Vector3 }[]>([]);
  const labelElsRef = useRef<(HTMLDivElement | null)[]>([]);
  // Floating labels for moving scene actors (`node_transform`); their DOM nodes
  // are projected from each marker's live position every frame.
  const actorLabelElsRef = useRef<(HTMLDivElement | null)[]>([]);
  const showLabelsRef = useRef(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [timeline, setTimeline] = useState<TimelineLane[]>([]);
  const [proxyLabels, setProxyLabels] = useState<string[]>([]);
  const [actorLabels, setActorLabels] = useState<string[]>([]);
  const [showLabels, setShowLabels] = useState(true);

  // Mirror the labels-visible flag into a ref for the render loop.
  useEffect(() => {
    showLabelsRef.current = showLabels;
  }, [showLabels]);

  // Keep the overlay filter in a ref so toggling a type re-renders the 3D view
  // (via `dirtyRef`) without tearing down and rebuilding the whole Babylon scene.
  useEffect(() => {
    hiddenRef.current = hiddenTypes ?? EMPTY_HIDDEN;
    dirtyRef.current = true;
  }, [hiddenTypes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;
    setPhase("loading");
    setError(null);
    setPlaying(false);
    setDuration(0);
    setProgress(0);
    setTimeline([]);
    setProxyLabels([]);
    setActorLabels([]);
    labelCentersRef.current = [];
    labelElsRef.current = [];
    actorLabelElsRef.current = [];
    progressRef.current = 0;

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
          { fetchSessionEvents, ReplayPlayer },
        ] = await Promise.all([
          import("@babylonjs/core/Engines/engine.js"),
          import("@babylonjs/core/scene.js"),
          import("@babylonjs/core/Cameras/arcRotateCamera.js"),
          import("@babylonjs/core/Lights/hemisphericLight.js"),
          import("@babylonjs/core/Maths/math.js"),
          import("@babylonjs/core/Meshes/meshBuilder.js"),
          import("@babylonjs/core/Materials/standardMaterial.js"),
          import("@uptimizr/replay"),
          // Side effect only: registers Babylon's `Ray` so `scene.pick()` (used by
          // the hover overlay) works. Deep imports tree-shake it out otherwise →
          // "Ray was not registered as a side effect". Not destructured.
          import("@babylonjs/core/Culling/ray.js"),
        ]);

        const events = await fetchSessionEvents({ endpoint: baseUrl, apiKey, sessionId });
        if (disposed) return;
        if (events.length === 0) {
          setPhase("empty");
          return;
        }

        // Pull the registered proxy for THIS session's scene (ADR 0014) so the
        // AABB backdrop shows whenever the replayed session's scene was
        // registered — independent of the dashboard's scene filter. Derive the
        // sceneId from the first event that carries one (ADR 0010).
        let sessionSceneId: string | undefined;
        for (const e of events) {
          const sid = (e as { sceneId?: unknown }).sceneId;
          if (typeof sid === "string" && sid) {
            sessionSceneId = sid;
            break;
          }
        }
        const proxyMeshes = sessionSceneId
          ? ((
              await new CollectorApi(baseUrl, apiKey)
                .sceneRepresentation(sessionSceneId)
                .catch(() => null)
            )?.proxy?.meshes ?? [])
          : [];
        if (disposed) return;

        // Precompute camera samples and interaction rays so visualization is
        // deterministic under seek/play and independent of frame timing.
        const sorted = [...events].sort((a, b) => a.ts - b.ts);
        const baseTs = sorted[0]!.ts;
        const cameraSamples: CameraSample[] = [];
        const rays: InteractionRay[] = [];
        // Tracked scene actors (ADR 0027) → ordered world-space position samples.
        const actorSamples = new Map<string, ActorSample[]>();
        let latestCamera: [number, number, number] | null = null;
        for (const e of sorted) {
          const at = e.ts - baseTs;
          if (e.type === "camera_sample") {
            latestCamera = [e.position[0], e.position[1], e.position[2]];
            cameraSamples.push({
              at,
              position: latestCamera,
              direction: [e.direction[0], e.direction[1], e.direction[2]],
            });
            continue;
          }

          if (e.type === "node_transform") {
            // Bone-tier samples need the live rig, which the abstract proxy scene
            // doesn't have, so they're skipped (ADR 0027). A subtree actor (ADR
            // 0033) emits the root with no `childPath` plus one sample per child
            // keyed by `childPath`; key each by `nodeId[/childPath]` so every part
            // tracks as its own marker instead of collapsing onto the root.
            if (e.boneId) continue;
            const key = e.childPath ? `${e.nodeId}/${e.childPath}` : e.nodeId;
            let arr = actorSamples.get(key);
            if (!arr) {
              arr = [];
              actorSamples.set(key, arr);
            }
            arr.push({ at, position: [e.position[0], e.position[1], e.position[2]] });
            continue;
          }

          if (e.type === "pointer_click" && e.hitPoint) {
            const origin = e.ray?.origin ?? latestCamera;
            if (!origin) continue;
            rays.push({
              at,
              type: "pointer_click",
              origin: [origin[0], origin[1], origin[2]],
              hit: [e.hitPoint[0], e.hitPoint[1], e.hitPoint[2]],
            });
            continue;
          }

          if (e.type === "mesh_interaction" && e.point) {
            if (!latestCamera) continue;
            rays.push({
              at,
              type: "mesh_interaction",
              origin: [latestCamera[0], latestCamera[1], latestCamera[2]],
              hit: [e.point[0], e.point[1], e.point[2]],
            });
          }
        }

        if (cameraSamples.length === 0 && rays.length === 0 && actorSamples.size === 0) {
          setPhase("empty");
          return;
        }

        const engine = new Engine(canvas, true, { preserveDrawingBuffer: false });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

        const camera = new ArcRotateCamera(
          "birdview-cam",
          -Math.PI / 2,
          0.22,
          12,
          Vector3.Zero(),
          scene,
        );
        camera.attachControl(canvas, true);
        disableWheelZoom(camera);
        cameraRef.current = camera;
        new HemisphericLight("replay-light", new Vector3(0, 1, 0), scene);

        // Neutral reference frame: a ground grid so camera motion reads clearly.
        const ground = MeshBuilder.CreateGround(
          "replay-ground",
          { width: 20, height: 20, subdivisions: 20 },
          scene,
        );
        const gridMat = new StandardMaterial("replay-ground-mat", scene);
        gridMat.diffuseColor = new Color3(0.12, 0.14, 0.18);
        gridMat.wireframe = true;
        ground.material = gridMat;

        // Registered scene proxy (ADR 0014): one wireframe box per mesh AABB so
        // recorded camera/click motion reads against the developer's actual
        // scene. Each box is an individual mesh (proxy counts are small).
        //
        // Meshes tracked as moving actors (ADR 0033) are drawn only as live
        // markers, so skip their static proxy boxes — otherwise a self-moving
        // object (the NPC) appears twice: a frozen box plus the moving dot. Match
        // by the captured `path` (exact, or suffix to allow a nested actor root)
        // and fall back to the leaf name when the proxy predates paths.
        const movingKeys = new Set(actorSamples.keys());
        const movingLeaves = new Set(
          Array.from(movingKeys, (k) => k.slice(k.lastIndexOf("/") + 1)),
        );
        const isMovingActor = (m: { name: string; path?: string }): boolean => {
          if (m.path) {
            for (const key of movingKeys) {
              if (m.path === key || m.path.endsWith(`/${key}`)) return true;
            }
          }
          return movingLeaves.has(m.name);
        };
        const labelCenters: { name: string; center: Vector3 }[] = [];
        for (const m of proxyMeshes) {
          if (isMovingActor(m)) continue;
          const a = m.aabb;
          const sx = Math.max(a[3] - a[0], 1e-3);
          const sy = Math.max(a[4] - a[1], 1e-3);
          const sz = Math.max(a[5] - a[2], 1e-3);
          const proxyBox = MeshBuilder.CreateBox(
            `replay-proxy-${m.name}`,
            { width: sx, height: sy, depth: sz },
            scene,
          );
          proxyBox.position = new Vector3((a[0] + a[3]) / 2, (a[1] + a[4]) / 2, (a[2] + a[5]) / 2);
          const proxyMat = new StandardMaterial(`replay-proxy-mat-${m.name}`, scene);
          proxyMat.wireframe = true;
          proxyMat.disableLighting = true;
          proxyMat.emissiveColor = new Color3(0.32, 0.4, 0.52);
          proxyMat.alpha = 0.35;
          proxyBox.material = proxyMat;
          proxyBox.isPickable = false;
          // Anchor an HTML label at the top-center of the box so it floats above
          // the wireframe without occluding it.
          labelCenters.push({
            name: m.name,
            center: new Vector3((a[0] + a[3]) / 2, a[4], (a[2] + a[5]) / 2),
          });
        }
        labelCentersRef.current = labelCenters;
        labelElsRef.current = labelCenters.map(() => null);
        setProxyLabels(labelCenters.map((l) => l.name));

        // Moving scene actors (ADR 0027) → one emissive marker per tracked
        // `nodeId[/childPath]`. A subtree actor (ADR 0033) yields one marker for
        // the root and one per captured child, each re-positioned every frame
        // from its interpolated `node_transform` track so self-driven motion (an
        // ambient NPC, a door) reads in the birdview.
        type ReplayMesh = ReturnType<typeof MeshBuilder.CreateSphere>;
        const ACTOR_COLORS: [number, number, number][] = [
          [0.91, 0.47, 0.98], // fuchsia
          [0.4, 0.95, 0.6], // green
          [0.98, 0.8, 0.3], // amber
          [0.45, 0.85, 1], // sky
        ];
        const actorMarkers: { key: string; mesh: ReplayMesh; samples: ActorSample[] }[] = [];
        let actorColorIdx = 0;
        for (const [key, samples] of actorSamples) {
          if (samples.length === 0) continue;
          const marker = MeshBuilder.CreateSphere(
            `replay-actor-${key}`,
            { diameter: 0.5, segments: 12 },
            scene,
          );
          const markerMat = new StandardMaterial(`replay-actor-mat-${key}`, scene);
          markerMat.disableLighting = true;
          const c = ACTOR_COLORS[actorColorIdx % ACTOR_COLORS.length]!;
          markerMat.emissiveColor = new Color3(c[0], c[1], c[2]);
          marker.material = markerMat;
          marker.isPickable = false;
          marker.isVisible = false;
          actorMarkers.push({ key, mesh: marker, samples });
          actorColorIdx++;
        }
        actorLabelElsRef.current = actorMarkers.map(() => null);
        setActorLabels(actorMarkers.map((a) => a.key));

        // Interpolate an actor's world position at the playhead. Returns null
        // before its first sample (not yet seen) so the marker stays hidden.
        const findActorPos = (
          samples: ActorSample[],
          elapsed: number,
        ): [number, number, number] | null => {
          if (samples.length === 0 || elapsed < samples[0]!.at) return null;
          let lo = 0;
          let hi = samples.length - 1;
          let best = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (samples[mid]!.at <= elapsed) {
              best = mid;
              lo = mid + 1;
            } else {
              hi = mid - 1;
            }
          }
          if (best < 0) return null;
          const a = samples[best]!;
          const b = samples[best + 1];
          if (!b) return a.position;
          const span = b.at - a.at;
          if (span <= 0) return a.position;
          const t = Math.max(0, Math.min(1, (elapsed - a.at) / span));
          return [
            a.position[0] + (b.position[0] - a.position[0]) * t,
            a.position[1] + (b.position[1] - a.position[1]) * t,
            a.position[2] + (b.position[2] - a.position[2]) * t,
          ];
        };

        const currentCam = MeshBuilder.CreateSphere(
          "replay-camera-origin",
          { diameter: 0.35, segments: 8 },
          scene,
        );
        const currentCamMat = new StandardMaterial("replay-camera-origin-mat", scene);
        currentCamMat.disableLighting = true;
        currentCamMat.emissiveColor = new Color3(0.6, 0.9, 1);
        currentCam.material = currentCamMat;

        let frustumLine = MeshBuilder.CreateLines(
          "replay-camera-frustum",
          { points: [Vector3.Zero(), new Vector3(0, 0, 1)] },
          scene,
        );
        frustumLine.color = new Color3(0.7, 0.95, 1);
        frustumLine.isPickable = false;

        // `CreateLineSystem` warns ("Setting vertex data kind 'position' with an
        // empty array") when handed zero lines, which happens both at init and on
        // any frame with no active geometry. Build only when there's geometry,
        // disposing the previous handle and keeping `null` otherwise.
        type LineSystem = ReturnType<typeof MeshBuilder.CreateLineSystem>;
        const rebuildLines = (
          prev: LineSystem | null,
          name: string,
          lines: InstanceType<typeof Vector3>[][],
          colors?: InstanceType<typeof Color4>[][],
        ): LineSystem | null => {
          prev?.dispose();
          if (lines.length === 0) return null;
          const mesh = MeshBuilder.CreateLineSystem(
            name,
            { lines, ...(colors ? { colors, useVertexAlpha: true } : {}) },
            scene,
          );
          mesh.isPickable = false;
          return mesh;
        };

        let trailLines: LineSystem | null = null;
        let trailHits: LineSystem | null = null;

        // Persistent markers: a faint cross at every click/pick hit, always shown
        // so the full interaction footprint stays readable even when paused far
        // from an event. Rebuilt only when the hidden-types filter changes.
        let persistentMarks: LineSystem | null = null;
        const buildPersistentMarks = () => {
          const hidden = hiddenRef.current;
          const lines: InstanceType<typeof Vector3>[][] = [];
          const colors: InstanceType<typeof Color4>[][] = [];
          const s = 0.1;
          for (const r of rays) {
            if (hidden.has(r.type)) continue;
            const [x, y, z] = r.hit;
            // Cyan-ish for mesh picks, amber for raw clicks.
            const c =
              r.type === "mesh_interaction"
                ? new Color4(0.45, 0.85, 1, 0.32)
                : new Color4(1, 0.7, 0.35, 0.32);
            lines.push([new Vector3(x - s, y, z), new Vector3(x + s, y, z)]);
            lines.push([new Vector3(x, y - s, z), new Vector3(x, y + s, z)]);
            lines.push([new Vector3(x, y, z - s), new Vector3(x, y, z + s)]);
            colors.push([c, c], [c, c], [c, c]);
          }
          persistentMarks = rebuildLines(persistentMarks, "replay-persistent-marks", lines, colors);
        };
        buildPersistentMarks();

        // Glow orb that pulses on the most-recent event as the playhead passes it.
        const glowOrb = MeshBuilder.CreateSphere(
          "replay-glow",
          { diameter: 1, segments: 12 },
          scene,
        );
        const glowMat = new StandardMaterial("replay-glow-mat", scene);
        glowMat.disableLighting = true;
        glowMat.emissiveColor = new Color3(1, 0.62, 0.2);
        glowMat.alpha = 0;
        glowOrb.material = glowMat;
        glowOrb.isPickable = false;
        glowOrb.isVisible = false;

        const safeRadius = (value: number) => (Number.isFinite(value) ? Math.max(8, value) : 12);

        const allPoints: [number, number, number][] = [];
        for (const s of cameraSamples) allPoints.push(s.position);
        for (const r of rays) {
          allPoints.push(r.origin);
          allPoints.push(r.hit);
        }
        for (const arr of actorSamples.values()) for (const s of arr) allPoints.push(s.position);
        if (allPoints.length > 0) {
          let minX = allPoints[0]![0];
          let minY = allPoints[0]![1];
          let minZ = allPoints[0]![2];
          let maxX = minX;
          let maxY = minY;
          let maxZ = minZ;
          for (const p of allPoints) {
            minX = Math.min(minX, p[0]);
            minY = Math.min(minY, p[1]);
            minZ = Math.min(minZ, p[2]);
            maxX = Math.max(maxX, p[0]);
            maxY = Math.max(maxY, p[1]);
            maxZ = Math.max(maxZ, p[2]);
          }
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          const cz = (minZ + maxZ) / 2;
          const dx = maxX - minX;
          const dy = maxY - minY;
          const dz = maxZ - minZ;
          const span = Math.sqrt(dx * dx + dy * dy + dz * dz);
          camera.setTarget(new Vector3(cx, cy, cz));
          camera.radius = safeRadius(span * 1.3);
        }

        const findCameraAt = (elapsed: number): CameraSample | null => {
          if (cameraSamples.length === 0) return null;
          let lo = 0;
          let hi = cameraSamples.length - 1;
          let best = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (cameraSamples[mid]!.at <= elapsed) {
              best = mid;
              lo = mid + 1;
            } else {
              hi = mid - 1;
            }
          }
          return best >= 0 ? cameraSamples[best]! : null;
        };

        let lastRenderedMs = -1;
        const redrawAt = (elapsed: number) => {
          const dirty = dirtyRef.current;
          if (!dirty && elapsed === lastRenderedMs) return;
          dirtyRef.current = false;
          lastRenderedMs = elapsed;

          // Filter changed (a type was toggled): rebuild the persistent footprint.
          if (dirty) buildPersistentMarks();
          const hidden = hiddenRef.current;

          const sample = hidden.has("camera_sample") ? null : findCameraAt(elapsed);
          if (sample) {
            currentCam.isVisible = true;
            frustumLine.isVisible = true;
            currentCam.position.set(sample.position[0], sample.position[1], sample.position[2]);
            const d = sample.direction;
            const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) || 1;
            const reach = 1.4;
            const tip = new Vector3(
              sample.position[0] + (d[0] / len) * reach,
              sample.position[1] + (d[1] / len) * reach,
              sample.position[2] + (d[2] / len) * reach,
            );
            frustumLine = MeshBuilder.CreateLines(
              "replay-camera-frustum",
              { points: [currentCam.position.clone(), tip], instance: frustumLine },
              scene,
            );
          } else {
            currentCam.isVisible = false;
            frustumLine.isVisible = false;
          }

          // Re-place each tracked actor at its interpolated position (or hide it
          // before its first sample / when the type is filtered out).
          const actorsHidden = hidden.has("node_transform");
          for (const a of actorMarkers) {
            const pos = actorsHidden ? null : findActorPos(a.samples, elapsed);
            if (!pos) {
              a.mesh.isVisible = false;
              continue;
            }
            a.mesh.isVisible = true;
            a.mesh.position.set(pos[0], pos[1], pos[2]);
          }

          const active = rays.filter(
            (r) => !hidden.has(r.type) && r.at <= elapsed && r.at >= elapsed - TRAIL_MS,
          );
          const rayLines: InstanceType<typeof Vector3>[][] = [];
          const rayColors: InstanceType<typeof Color4>[][] = [];
          const hitCrosses: InstanceType<typeof Vector3>[][] = [];
          const hitColors: InstanceType<typeof Color4>[][] = [];
          let glow: { hit: [number, number, number]; t: number } | null = null;
          for (const r of active) {
            const age = elapsed - r.at;
            const t = Math.max(0, Math.min(1, 1 - age / TRAIL_MS));
            const color = new Color4(1, 0.62, 0.2, 0.18 + 0.72 * t);
            const origin = new Vector3(r.origin[0], r.origin[1], r.origin[2]);
            const hit = new Vector3(r.hit[0], r.hit[1], r.hit[2]);
            rayLines.push([origin, hit]);
            rayColors.push([color, color]);

            const s = 0.12 + 0.08 * t;
            hitCrosses.push([
              new Vector3(hit.x - s, hit.y, hit.z),
              new Vector3(hit.x + s, hit.y, hit.z),
            ]);
            hitCrosses.push([
              new Vector3(hit.x, hit.y - s, hit.z),
              new Vector3(hit.x, hit.y + s, hit.z),
            ]);
            hitCrosses.push([
              new Vector3(hit.x, hit.y, hit.z - s),
              new Vector3(hit.x, hit.y, hit.z + s),
            ]);
            const h = new Color4(1, 0.78, 0.42, 0.22 + 0.72 * t);
            hitColors.push([h, h], [h, h], [h, h]);

            // Brightest, most-recent event within the glow window drives the orb.
            if (age <= GLOW_MS) {
              const gt = 1 - age / GLOW_MS;
              if (!glow || gt > glow.t) glow = { hit: r.hit, t: gt };
            }
          }

          if (glow) {
            const scale = 0.25 + 0.9 * glow.t;
            glowOrb.isVisible = true;
            glowOrb.scaling.set(scale, scale, scale);
            glowOrb.position.set(glow.hit[0], glow.hit[1], glow.hit[2]);
            glowMat.alpha = 0.12 + 0.5 * glow.t;
          } else {
            glowOrb.isVisible = false;
          }

          trailLines = rebuildLines(trailLines, "replay-trail-lines", rayLines, rayColors);
          trailHits = rebuildLines(trailHits, "replay-trail-hits", hitCrosses, hitColors);
        };

        const driver = {
          reset() {
            // Visualization state is fully driven by playhead time in redrawAt.
          },
          apply() {
            // No-op: data application is deterministic from elapsedMs.
          },
        };

        const player = new ReplayPlayer(events, driver, {
          onProgress: (elapsed) => {
            if (!disposed) {
              progressRef.current = elapsed;
              setProgress(elapsed);
            }
          },
          onComplete: () => {
            if (!disposed) setPlaying(false);
          },
        });
        playerRef.current = player;
        setDuration(player.durationMs);
        setTimeline(buildTimeline(sorted, baseTs, player.durationMs));
        player.update(0);
        redrawAt(0);

        // Float each proxy-mesh label over its box by projecting the box's
        // top-center into client pixels every frame. Drives the DOM directly
        // (no React state per frame); hidden when behind the camera or toggled off.
        const identity = Matrix.Identity();
        const positionLabels = () => {
          const centers = labelCentersRef.current;
          const els = labelElsRef.current;
          if (!showLabelsRef.current) return;
          const w = canvas.clientWidth || engine.getRenderWidth();
          const h = canvas.clientHeight || engine.getRenderHeight();
          const viewport = camera.viewport.toGlobal(w, h);
          const transform = scene.getTransformMatrix();
          for (let i = 0; i < centers.length; i++) {
            const el = els[i];
            if (!el) continue;
            const p = Vector3.Project(centers[i]!.center, identity, transform, viewport);
            if (p.z < 0 || p.z > 1) {
              el.style.opacity = "0";
              continue;
            }
            el.style.opacity = "1";
            el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -140%)`;
          }
          // Actor labels track their marker's live position (the marker moves).
          const actorEls = actorLabelElsRef.current;
          for (let i = 0; i < actorMarkers.length; i++) {
            const el = actorEls[i];
            if (!el) continue;
            const marker = actorMarkers[i]!.mesh;
            if (!marker.isVisible) {
              el.style.opacity = "0";
              continue;
            }
            const p = Vector3.Project(marker.position, identity, transform, viewport);
            if (p.z < 0 || p.z > 1) {
              el.style.opacity = "0";
              continue;
            }
            el.style.opacity = "1";
            el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -180%)`;
          }
        };

        engine.runRenderLoop(() => {
          redrawAt(progressRef.current);
          scene.render();
          positionLabels();
        });
        const onResize = () => engine.resize();
        window.addEventListener("resize", onResize);

        setPhase("ready");
        cleanup = () => {
          window.removeEventListener("resize", onResize);
          player.pause();
          frustumLine.dispose();
          trailLines?.dispose();
          trailHits?.dispose();
          persistentMarks?.dispose();
          glowOrb.dispose();
          scene.dispose();
          engine.dispose();
          cameraRef.current = null;
          playerRef.current = null;
        };
      } catch (err) {
        if (disposed) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : "Failed to load replay.");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [baseUrl, apiKey, sessionId]);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    setPlaying((p) => {
      if (p) player.pause();
      else player.play();
      return !p;
    });
  }, []);

  const onSeek = useCallback((value: number) => {
    const player = playerRef.current;
    if (!player) return;
    player.pause();
    player.seek(value);
    setPlaying(false);
    progressRef.current = value;
    setProgress(value);
  }, []);

  return (
    <Panel
      title="Session replay (birdview timeline)"
      subtitle="Scrub the camera path and interaction rays; every click stays marked and glows as the playhead passes it. The color-coded strip marks when each event fired (click to seek)."
    >
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="aspect-video w-full rounded-lg border border-edge bg-ink"
        />
        {/* Proxy-mesh AABB labels — positioned per-frame by the render loop. */}
        <div
          className={`pointer-events-none absolute inset-0 overflow-hidden ${
            showLabels ? "" : "hidden"
          }`}
        >
          {proxyLabels.map((name, i) => (
            <div
              key={name}
              ref={(el) => {
                labelElsRef.current[i] = el;
              }}
              className="absolute left-0 top-0 whitespace-nowrap rounded bg-ink/80 px-1.5 py-0.5 text-[10px] font-medium text-saffron opacity-0 ring-1 ring-amber/30"
            >
              {name}
            </div>
          ))}
          {actorLabels.map((name, i) => (
            <div
              key={`actor-${name}`}
              ref={(el) => {
                actorLabelElsRef.current[i] = el;
              }}
              className="absolute left-0 top-0 whitespace-nowrap rounded bg-ink/80 px-1.5 py-0.5 text-[10px] font-medium text-fuchsia-300 opacity-0 ring-1 ring-fuchsia-400/30"
            >
              {name}
            </div>
          ))}
        </div>
        {phase === "ready" && (proxyLabels.length > 0 || actorLabels.length > 0) ? (
          <button
            type="button"
            onClick={() => setShowLabels((v) => !v)}
            className="absolute left-3 top-3 rounded-md border border-edge bg-ink/80 px-2 py-1 text-xs font-medium text-fg transition hover:bg-ink hover:text-white"
            aria-pressed={showLabels ? "true" : "false"}
          >
            {showLabels ? "Hide labels" : "Show labels"}
          </button>
        ) : null}
        {phase === "ready" ? (
          <ZoomButtons onZoom={(f) => cameraRef.current && stepZoom(cameraRef.current, f)} />
        ) : null}
        {phase !== "ready" ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-fg-muted">
            {phase === "loading"
              ? "Loading replay…"
              : phase === "empty"
                ? "No replayable events (raw retention may be disabled)."
                : phase === "error"
                  ? (error ?? "Replay unavailable.")
                  : null}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          disabled={phase !== "ready"}
          className="rounded-md bg-amber px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-ember disabled:opacity-40"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <span className="w-12 text-right font-mono text-xs tabular-nums text-fg-muted">
          {formatClock(progress)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(1, duration)}
          step={50}
          value={Math.min(progress, duration)}
          onChange={(e) => onSeek(Number(e.target.value))}
          disabled={phase !== "ready"}
          className="flex-1 accent-amber"
        />
        <span className="w-12 font-mono text-xs tabular-nums text-fg-muted">
          {formatClock(duration)}
        </span>
      </div>

      {phase === "ready" ? (
        <EventTimeline
          lanes={timeline}
          duration={duration}
          progress={progress}
          onSeek={onSeek}
          hiddenTypes={hiddenTypes ?? EMPTY_HIDDEN}
        />
      ) : null}
    </Panel>
  );
}
