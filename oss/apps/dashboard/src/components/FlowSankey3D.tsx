"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { CollectorApi, type FlowLink, type QueryParams, type SceneProxyMesh } from "@/lib/api";
import {
  buildTwoStageGraph,
  voxelKey,
  type FlowStandpoint,
  type TwoStageCaps,
  type TwoStageKind,
  type TwoStageRibbon,
} from "@/lib/flowGraph";
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
type ViewMode = "aggregate" | "twostage";
/** Walk = first-person, orbit = viewer, all = both (§7.8 slice 4, ADR 0026). */
type CameraModeChoice = "all" | "viewer" | "first-person";
const ALL = "__all__";

const TWO_STAGE_CAPS: TwoStageCaps = { maxStandpoints: 6, maxMeshes: 10, maxRibbons: 70 };

function sourceKey(azimuthBin: number, elevationBin: number): string {
  return `${azimuthBin}|${elevationBin}`;
}

function meshCenter(mesh: SceneProxyMesh): [number, number, number] {
  const a = mesh.aabb;
  return [(a[0] + a[3]) / 2, (a[1] + a[4]) / 2, (a[2] + a[5]) / 2];
}

function meshHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Aggregate gaze→mesh flow panel (design §7.5, slice 2).
 *
 * Draws top-N links from camera-direction bins (source on a direction dome)
 * toward meshes (target nodes), with tube radius/color scaled by link volume.
 * This is the no-timeline, de-cluttered counterpart to event-level rays.
 *
 * This is the panel BODY only (no chrome); {@link FlowSankey3D} wraps it in
 * panel chrome for legacy call sites. The host supplies title/subtitle/help via
 * the ADR 0036 panel contract.
 */
export function FlowSankey3DView({
  links,
  gridSize,
  proxyMeshes = [],
  maxLinks = 80,
  baseUrl,
  apiKey,
  flowQuery,
  hasFirstPerson = false,
}: {
  links: FlowLink[];
  gridSize: number;
  proxyMeshes?: SceneProxyMesh[];
  maxLinks?: number;
  /** Collector base URL; when set with `flowQuery` the panel refetches by camera mode (§7.8 slice 4). */
  baseUrl?: string;
  apiKey?: string;
  /** Resolved base query (range/scene/source) the panel re-issues per camera mode. */
  flowQuery?: QueryParams | null;
  /** Whether the active scene(s) report first-person samples — drives walk defaulting + the hint. */
  hasFirstPerson?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<OrbitFocusCamera | null>(null);
  const homeRef = useRef<OrbitHome | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [meshFocus, setMeshFocus] = useState<string>(ALL);
  const [sourceFocus, setSourceFocus] = useState<string>(ALL);
  const [standpointFocus, setStandpointFocus] = useState<string>(ALL);
  const [viewMode, setViewMode] = useState<ViewMode>("aggregate");
  const [tip, setTip] = useState<HoverTip | null>(null);

  // §7.8 slice 4: camera-mode dimension. The panel can re-issue the flow query
  // scoped to walk (first-person) / orbit (viewer) / all. It owns the rows it
  // renders once it can self-fetch; otherwise it falls back to the `links` prop.
  const [cameraMode, setCameraMode] = useState<CameraModeChoice>("all");
  const [rows, setRows] = useState<FlowLink[]>(links);
  const selfFetch = Boolean(baseUrl && flowQuery);
  const flowQueryKey = useMemo(() => (flowQuery ? JSON.stringify(flowQuery) : ""), [flowQuery]);
  const didDefaultMode = useRef(false);

  // Auto-default to walk once we learn the scene has first-person samples — but
  // only once, so an explicit user choice afterwards sticks (ADR 0026).
  useEffect(() => {
    if (didDefaultMode.current) return;
    if (hasFirstPerson) {
      setCameraMode("first-person");
      didDefaultMode.current = true;
    }
  }, [hasFirstPerson]);

  // Orbit (viewer) flow is disabled for walkable scenes; if the scene turns out
  // to be walkable while Orbit was selected, fall back to walk so the now-
  // disabled button can't leave the panel stuck in a broken state.
  useEffect(() => {
    if (hasFirstPerson && cameraMode === "viewer") setCameraMode("first-person");
  }, [hasFirstPerson, cameraMode]);

  // Keep rows in sync with the prop when the panel can't self-fetch.
  useEffect(() => {
    if (!selfFetch) setRows(links);
  }, [links, selfFetch]);

  // Re-issue the flow query per camera mode when self-fetch is available.
  useEffect(() => {
    if (!baseUrl || !flowQuery) return;
    let cancelled = false;
    const api = new CollectorApi(baseUrl, apiKey ?? "");
    const mode = cameraMode === "all" ? undefined : cameraMode;
    api
      .flowHeatmap({
        ...flowQuery,
        bins: gridSize,
        limit: 400,
        groupByOrigin: true,
        cameraMode: mode,
      })
      .then((res) => {
        if (!cancelled) setRows(res);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
    // flowQueryKey captures flowQuery contents; the listed primitives keep the
    // fetch stable across renders without re-running on every new object identity.
  }, [baseUrl, apiKey, flowQueryKey, cameraMode, gridSize]);

  // §7.8 slice 2: standpoints are the camera-position voxels the links were made
  // from. Roll the position-aware rows up per origin voxel (count + count-weighted
  // average world point) so the panel can list and gate by where the viewer stood.
  const standpoints = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        voxel: [number, number, number];
        count: number;
        ox: number;
        oy: number;
        oz: number;
        wsum: number;
      }
    >();
    for (const l of rows) {
      if (!l.originVoxel) continue;
      const key = voxelKey(l.originVoxel);
      const o = l.origin;
      const cur = map.get(key);
      if (cur) {
        cur.count += l.count;
        if (o) {
          cur.ox += o[0] * l.count;
          cur.oy += o[1] * l.count;
          cur.oz += o[2] * l.count;
          cur.wsum += l.count;
        }
      } else {
        map.set(key, {
          key,
          voxel: l.originVoxel,
          count: l.count,
          ox: o ? o[0] * l.count : 0,
          oy: o ? o[1] * l.count : 0,
          oz: o ? o[2] * l.count : 0,
          wsum: o ? l.count : 0,
        });
      }
    }
    return [...map.values()]
      .map((s) => ({
        key: s.key,
        voxel: s.voxel,
        count: s.count,
        origin:
          s.wsum > 0
            ? ([s.ox / s.wsum, s.oy / s.wsum, s.oz / s.wsum] as [number, number, number])
            : undefined,
      }))
      .sort((a, b) => b.count - a.count);
  }, [rows]);

  const hasStandpoints = standpoints.length > 0;

  const selectedStandpoint = useMemo(
    () =>
      standpointFocus === ALL ? null : (standpoints.find((s) => s.key === standpointFocus) ?? null),
    [standpoints, standpointFocus],
  );

  // §7.8 slice 3: the three-column standpoint → gaze-sector → mesh graph. Built
  // from the same position-aware rows; capped + tail-folded so it stays legible.
  const twoStage = useMemo(
    () => buildTwoStageGraph(rows, standpoints, gridSize, TWO_STAGE_CAPS),
    [rows, standpoints, gridSize],
  );
  const isTwoStage = viewMode === "twostage" && hasStandpoints;

  // Fall back to the aggregate view when no standpoints are available.
  useEffect(() => {
    if (viewMode === "twostage" && !hasStandpoints) setViewMode("aggregate");
  }, [viewMode, hasStandpoints]);

  // The links actually rendered: either collapsed across all standpoints (the
  // §7.5 view) or filtered to one standpoint voxel. Collapsing sums duplicate
  // (azimuth, elevation, mesh) rows that differ only by origin.
  const effectiveLinks = useMemo<FlowLink[]>(() => {
    if (standpointFocus !== ALL && hasStandpoints) {
      return rows.filter((l) => l.originVoxel && voxelKey(l.originVoxel) === standpointFocus);
    }
    if (!hasStandpoints) return rows;
    const map = new Map<string, FlowLink>();
    for (const l of rows) {
      const k = `${l.azimuth_bin}|${l.elevation_bin}|${l.mesh}`;
      const cur = map.get(k);
      if (cur) cur.count += l.count;
      else
        map.set(k, {
          azimuth_bin: l.azimuth_bin,
          elevation_bin: l.elevation_bin,
          mesh: l.mesh,
          count: l.count,
        });
    }
    return [...map.values()];
  }, [rows, standpointFocus, hasStandpoints]);

  const visible = useMemo(() => {
    const sorted = [...effectiveLinks].sort((a, b) => b.count - a.count);
    return sorted.slice(0, Math.max(1, maxLinks));
  }, [effectiveLinks, maxLinks]);

  const meshCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const link of visible) map.set(link.mesh, (map.get(link.mesh) ?? 0) + link.count);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [visible]);

  const sourceCounts = useMemo(() => {
    const map = new Map<string, { azimuthBin: number; elevationBin: number; count: number }>();
    for (const link of visible) {
      const key = sourceKey(link.azimuth_bin, link.elevation_bin);
      const cur = map.get(key);
      if (cur) cur.count += link.count;
      else {
        map.set(key, {
          azimuthBin: link.azimuth_bin,
          elevationBin: link.elevation_bin,
          count: link.count,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [visible]);

  // Keep filters valid when top-N links shift under new global filters. These
  // validate against the aggregate-view option lists, so they only run there;
  // switching view mode resets all three focuses below.
  useEffect(() => {
    if (isTwoStage || meshFocus === ALL) return;
    if (!meshCounts.some(([name]) => name === meshFocus)) {
      setMeshFocus(ALL);
    }
  }, [isTwoStage, meshFocus, meshCounts]);

  useEffect(() => {
    if (isTwoStage || sourceFocus === ALL) return;
    if (!sourceCounts.some((s) => sourceKey(s.azimuthBin, s.elevationBin) === sourceFocus)) {
      setSourceFocus(ALL);
    }
  }, [isTwoStage, sourceFocus, sourceCounts]);

  // Drop a standpoint selection that no longer exists under new global filters.
  useEffect(() => {
    if (isTwoStage || standpointFocus === ALL) return;
    if (!standpoints.some((s) => s.key === standpointFocus)) {
      setStandpointFocus(ALL);
    }
  }, [isTwoStage, standpointFocus, standpoints]);

  // Reset focus when switching between aggregate and two-stage views, since the
  // selector option sets differ (e.g. two-stage adds "other" buckets).
  useEffect(() => {
    setMeshFocus(ALL);
    setSourceFocus(ALL);
    setStandpointFocus(ALL);
  }, [viewMode]);

  const activeCount = useMemo(() => {
    if (isTwoStage) {
      return twoStage.ribbons.filter((r) => {
        const spOk = standpointFocus === ALL || r.standpointId === standpointFocus;
        const gazeOk =
          sourceFocus === ALL || sourceKey(r.azimuthBin, r.elevationBin) === sourceFocus;
        const meshOk = meshFocus === ALL || r.meshId === meshFocus;
        return spOk && gazeOk && meshOk;
      }).length;
    }
    return visible.filter((link) => {
      const sourceOk =
        sourceFocus === ALL || sourceKey(link.azimuth_bin, link.elevation_bin) === sourceFocus;
      const meshOk = meshFocus === ALL || link.mesh === meshFocus;
      return sourceOk && meshOk;
    }).length;
  }, [isTwoStage, twoStage, visible, meshFocus, sourceFocus, standpointFocus]);

  const totalCount = isTwoStage ? twoStage.ribbons.length : visible.length;

  // Mode-aware selector option lists (aggregate links vs. capped two-stage graph).
  const standpointOptions = useMemo(() => {
    if (isTwoStage) {
      return twoStage.standpoints.map((n) => ({ value: n.id, label: `${n.label} · ${n.count}` }));
    }
    return standpoints.slice(0, 24).map((s) => ({
      value: s.key,
      label: `[${s.voxel[0]}, ${s.voxel[1]}, ${s.voxel[2]}] · ${s.count}`,
    }));
  }, [isTwoStage, twoStage, standpoints]);

  const gazeOptions = useMemo(() => {
    if (isTwoStage) {
      const m = new Map<string, { az: number; el: number; count: number }>();
      for (const r of twoStage.ribbons) {
        const k = sourceKey(r.azimuthBin, r.elevationBin);
        const cur = m.get(k);
        if (cur) cur.count += r.count;
        else m.set(k, { az: r.azimuthBin, el: r.elevationBin, count: r.count });
      }
      return [...m.values()]
        .sort((a, b) => b.count - a.count)
        .map((s) => ({ value: sourceKey(s.az, s.el), label: `(${s.az}, ${s.el}) · ${s.count}` }));
    }
    return sourceCounts.map((s) => ({
      value: sourceKey(s.azimuthBin, s.elevationBin),
      label: `(${s.azimuthBin}, ${s.elevationBin}) · ${s.count}`,
    }));
  }, [isTwoStage, twoStage, sourceCounts]);

  const meshOptions = useMemo(() => {
    if (isTwoStage) {
      return twoStage.meshes.map((n) => ({ value: n.id, label: `${n.label} · ${n.count}` }));
    }
    return meshCounts.map(([name, count]) => ({ value: name, label: `${name} · ${count}` }));
  }, [isTwoStage, twoStage, meshCounts]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (isTwoStage) return;
    if (visible.length === 0) {
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
          // Side-effect: registers Babylon's `Ray` so `scene.pick()` (hover
          // overlay) works; deep imports tree-shake it out otherwise.
          import("@babylonjs/core/Culling/ray.js"),
        ]);
        if (disposed) return;

        const engine = new Engine(canvas, true, { preserveDrawingBuffer: false });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

        const proxyByMesh = new Map<string, [number, number, number]>();
        for (const m of proxyMeshes) proxyByMesh.set(m.name, meshCenter(m));

        // Build target positions (mesh nodes). Use proxy centroid when present,
        // otherwise place unknown meshes on a deterministic ring.
        const target = new Map<string, [number, number, number]>();
        const ringNames = meshCounts.map(([name]) => name).filter((name) => !proxyByMesh.has(name));
        const ringR = 2.2;
        const ringY = -0.35;
        for (let i = 0; i < ringNames.length; i++) {
          const name = ringNames[i]!;
          const h = meshHash(name);
          const a = (i / Math.max(1, ringNames.length)) * Math.PI * 2 + ((h % 100) / 100) * 0.35;
          target.set(name, [
            Math.cos(a) * ringR,
            ringY + ((h % 7) - 3) * 0.06,
            Math.sin(a) * ringR,
          ]);
        }
        for (const [name, pos] of proxyByMesh.entries()) target.set(name, pos);

        // Scene center from target nodes.
        let cx = 0;
        let cy = 0;
        let cz = 0;
        let targetN = 0;
        for (const p of target.values()) {
          cx += p[0];
          cy += p[1];
          cz += p[2];
          targetN++;
        }
        const center = new Vector3(
          cx / Math.max(1, targetN),
          cy / Math.max(1, targetN),
          cz / Math.max(1, targetN),
        );

        let targetExtent = 1.8;
        for (const p of target.values()) {
          const dx = p[0] - center.x;
          const dy = p[1] - center.y;
          const dz = p[2] - center.z;
          targetExtent = Math.max(targetExtent, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        const sourceRadius = targetExtent * 0.75 + 1;

        // Scale node/tube sizes with the scene extent so links stay visible on
        // large (walkable) scenes, not just small viewer models. ~1.0 at the
        // 1.8 floor; grows proportionally as the proxy meshes spread out.
        const sizeScale = Math.max(1, targetExtent / 1.8);

        const maxCount = visible.reduce((m, l) => Math.max(m, l.count), 1);

        // Draw source and target nodes for legibility.
        const sourceNodeMat = new StandardMaterial("flow-source-node", scene);
        sourceNodeMat.disableLighting = true;
        sourceNodeMat.emissiveColor = new Color3(0.45, 0.75, 1);
        const targetNodeMat = new StandardMaterial("flow-target-node", scene);
        targetNodeMat.disableLighting = true;
        targetNodeMat.emissiveColor = new Color3(1, 0.82, 0.42);

        const sourceSeen = new Set<string>();
        const targetSeen = new Set<string>();

        const matchesFocus = (link: FlowLink): boolean => {
          const sourceOk =
            sourceFocus === ALL || sourceKey(link.azimuth_bin, link.elevation_bin) === sourceFocus;
          const meshOk = meshFocus === ALL || link.mesh === meshFocus;
          return sourceOk && meshOk;
        };

        const activeSource = new Set<string>();
        const activeMesh = new Set<string>();
        for (const link of visible) {
          if (!matchesFocus(link)) continue;
          activeSource.add(sourceKey(link.azimuth_bin, link.elevation_bin));
          activeMesh.add(link.mesh);
        }

        for (const link of visible) {
          const key = `${link.azimuth_bin}|${link.elevation_bin}`;
          const targetPos = target.get(link.mesh);
          if (!targetPos) continue;
          const isActive = matchesFocus(link);

          const az = ((link.azimuth_bin + 0.5) / gridSize) * Math.PI * 2 - Math.PI;
          const el = ((link.elevation_bin + 0.5) / gridSize) * Math.PI - Math.PI / 2;
          const ce = Math.cos(el);
          const dirX = ce * Math.cos(az);
          const dirY = Math.sin(el);
          const dirZ = ce * Math.sin(az);
          const src = new Vector3(
            center.x + dirX * sourceRadius,
            center.y + dirY * sourceRadius,
            center.z + dirZ * sourceRadius,
          );
          const dst = new Vector3(targetPos[0], targetPos[1], targetPos[2]);

          if (!sourceSeen.has(key)) {
            const s = MeshBuilder.CreateSphere(
              `flow-src-${key}`,
              { diameter: 0.12 * sizeScale, segments: 6 },
              scene,
            );
            s.position = src;
            const sm = sourceNodeMat.clone(`flow-src-mat-${key}`);
            const srcActive = activeSource.has(key);
            sm.alpha = srcActive || (meshFocus === ALL && sourceFocus === ALL) ? 1 : 0.22;
            s.material = sm;
            s.isPickable = false;
            sourceSeen.add(key);
          }
          if (!targetSeen.has(link.mesh)) {
            const t = MeshBuilder.CreateSphere(
              `flow-target-${link.mesh}`,
              { diameter: 0.2 * sizeScale, segments: 7 },
              scene,
            );
            t.position = dst;
            const tm = targetNodeMat.clone(`flow-target-mat-${link.mesh}`);
            const meshActive = activeMesh.has(link.mesh);
            tm.alpha = meshActive || (meshFocus === ALL && sourceFocus === ALL) ? 1 : 0.22;
            t.material = tm;
            t.isPickable = true;
            t.metadata = { hoverLabel: link.mesh };
            targetSeen.add(link.mesh);
          }

          const mid = src.add(dst).scale(0.5);
          const fromCenter = mid.subtract(center);
          const centerLen = Math.sqrt(
            fromCenter.x * fromCenter.x + fromCenter.y * fromCenter.y + fromCenter.z * fromCenter.z,
          );
          const nx = centerLen > 1e-6 ? fromCenter.x / centerLen : 0;
          const ny = centerLen > 1e-6 ? fromCenter.y / centerLen : 1;
          const nz = centerLen > 1e-6 ? fromCenter.z / centerLen : 0;
          const lift = (0.35 + (link.count / maxCount) * 0.75) * sizeScale;
          const ctrl = new Vector3(
            mid.x + nx * lift,
            mid.y + ny * lift + 0.12 * sizeScale,
            mid.z + nz * lift,
          );

          const path: InstanceType<typeof Vector3>[] = [];
          const seg = 18;
          for (let i = 0; i <= seg; i++) {
            const t = i / seg;
            const omt = 1 - t;
            path.push(
              new Vector3(
                omt * omt * src.x + 2 * omt * t * ctrl.x + t * t * dst.x,
                omt * omt * src.y + 2 * omt * t * ctrl.y + t * t * dst.y,
                omt * omt * src.z + 2 * omt * t * ctrl.z + t * t * dst.z,
              ),
            );
          }

          const intensity = link.count / maxCount;
          const [r, g, b] = heatRgb(intensity);
          const tube = MeshBuilder.CreateTube(
            `flow-link-${link.mesh}-${key}`,
            {
              path,
              radius: (isActive ? 1 : 0.4) * (0.012 + 0.04 * intensity) * sizeScale,
              tessellation: 8,
              cap: 0,
              sideOrientation: 0,
            },
            scene,
          );
          const m = new StandardMaterial(`flow-link-mat-${link.mesh}-${key}`, scene);
          m.disableLighting = true;
          m.emissiveColor = new Color3(r, g, b);
          m.alpha = isActive ? 0.35 + 0.65 * intensity : 0.08;
          tube.material = m;
          tube.isPickable = true;
          tube.metadata = { hoverLabel: link.mesh };
        }

        const camera = new ArcRotateCamera(
          "flow-cam",
          Math.PI / 4,
          Math.PI / 3,
          targetExtent * 3.4,
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
        new HemisphericLight("flow-light", new Vector3(0.3, 1, 0.2), scene);

        // Faint source dome reference.
        const dome = MeshBuilder.CreateSphere(
          "flow-source-dome",
          { diameter: sourceRadius * 2, segments: 20 },
          scene,
        );
        dome.position = center;
        const domeMat = new StandardMaterial("flow-source-dome-mat", scene);
        domeMat.wireframe = true;
        domeMat.disableLighting = true;
        domeMat.emissiveColor = new Color3(0.16, 0.2, 0.28);
        domeMat.alpha = 0.35;
        dome.material = domeMat;
        dome.isPickable = false;

        // §7.8 slice 2: when one standpoint is selected, mark where that vantage
        // sits in the scene (averaged origin world point) with a pin so the gated
        // flow reads spatially against the proxy meshes.
        const standpointOrigin = selectedStandpoint?.origin;
        if (standpointOrigin) {
          const pinPos = new Vector3(standpointOrigin[0], standpointOrigin[1], standpointOrigin[2]);
          const pin = MeshBuilder.CreateSphere(
            "flow-standpoint",
            { diameter: 0.26 * sizeScale, segments: 10 },
            scene,
          );
          pin.position = pinPos;
          const pinMat = new StandardMaterial("flow-standpoint-mat", scene);
          pinMat.disableLighting = true;
          pinMat.emissiveColor = new Color3(0.95, 0.45, 0.95);
          pin.material = pinMat;
          pin.isPickable = false;
          const stem = MeshBuilder.CreateLines(
            "flow-standpoint-stem",
            { points: [pinPos, new Vector3(pinPos.x, center.y, pinPos.z)] },
            scene,
          );
          stem.color = new Color3(0.95, 0.45, 0.95);
          stem.isPickable = false;
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
        setError(err instanceof Error ? err.message : "Failed to render flow links.");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [visible, gridSize, proxyMeshes, meshFocus, sourceFocus, selectedStandpoint, isTwoStage]);

  // §7.8 slice 3 renderer — three-column flow. Kept as its own effect so it owns
  // a fresh Babylon engine only while two-stage mode is active; toggling modes
  // disposes one engine and builds the other.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!isTwoStage) return;
    if (twoStage.ribbons.length === 0) {
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
          // Side-effect: registers Babylon's `Ray` so `scene.pick()` (hover
          // overlay) works; deep imports tree-shake it out otherwise.
          import("@babylonjs/core/Culling/ray.js"),
        ]);
        if (disposed) return;

        const engine = new Engine(canvas, true, { preserveDrawingBuffer: false });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

        const ribbonActive = (r: TwoStageRibbon): boolean => {
          const spOk = standpointFocus === ALL || r.standpointId === standpointFocus;
          const gazeOk =
            sourceFocus === ALL || sourceKey(r.azimuthBin, r.elevationBin) === sourceFocus;
          const meshOk = meshFocus === ALL || r.meshId === meshFocus;
          return spOk && gazeOk && meshOk;
        };
        const anyFocus = standpointFocus !== ALL || sourceFocus !== ALL || meshFocus !== ALL;

        const activeNodes = new Set<string>();
        for (const r of twoStage.ribbons) {
          if (!ribbonActive(r)) continue;
          activeNodes.add(r.standpointId);
          activeNodes.add(r.gazeId);
          activeNodes.add(r.meshId);
        }

        const nodeColor: Record<TwoStageKind, [number, number, number]> = {
          standpoint: [0.95, 0.45, 0.95],
          gaze: [0.45, 0.75, 1],
          mesh: [1, 0.82, 0.42],
        };
        const nodeSize: Record<TwoStageKind, number> = { standpoint: 0.26, gaze: 0.13, mesh: 0.22 };
        const allNodes = [...twoStage.standpoints, ...twoStage.gazes, ...twoStage.meshes];
        const posById = new Map(allNodes.map((n) => [n.id, n.pos]));
        const labelById = new Map(allNodes.map((n) => [n.id, n.label]));
        for (const n of allNodes) {
          const sphere = MeshBuilder.CreateSphere(
            `ts-node-${n.kind}-${n.id}`,
            { diameter: nodeSize[n.kind], segments: 8 },
            scene,
          );
          sphere.position = new Vector3(n.pos[0], n.pos[1], n.pos[2]);
          const mat = new StandardMaterial(`ts-node-mat-${n.kind}-${n.id}`, scene);
          mat.disableLighting = true;
          const [r, g, b] = nodeColor[n.kind];
          mat.emissiveColor = new Color3(r, g, b);
          mat.alpha = !anyFocus || activeNodes.has(n.id) ? 1 : 0.2;
          sphere.material = mat;
          sphere.isPickable = true;
          sphere.metadata = { hoverLabel: n.label };
        }

        const arcSegment = (
          a: [number, number, number],
          b: [number, number, number],
          lift: number,
        ): InstanceType<typeof Vector3>[] => {
          const ax = a[0];
          const ay = a[1];
          const az = a[2];
          const bx = b[0];
          const by = b[1];
          const bz = b[2];
          const ctrl = [(ax + bx) / 2, (ay + by) / 2 + lift, (az + bz) / 2] as const;
          const out: InstanceType<typeof Vector3>[] = [];
          const seg = 12;
          for (let i = 0; i <= seg; i++) {
            const t = i / seg;
            const omt = 1 - t;
            out.push(
              new Vector3(
                omt * omt * ax + 2 * omt * t * ctrl[0] + t * t * bx,
                omt * omt * ay + 2 * omt * t * ctrl[1] + t * t * by,
                omt * omt * az + 2 * omt * t * ctrl[2] + t * t * bz,
              ),
            );
          }
          return out;
        };

        for (const r of twoStage.ribbons) {
          const spPos = posById.get(r.standpointId);
          const gazePos = posById.get(r.gazeId);
          const meshPos = posById.get(r.meshId);
          if (!spPos || !gazePos || !meshPos) continue;
          const intensity = r.count / twoStage.maxCount;
          const lift = 0.18 + intensity * 0.5;
          const path = [
            ...arcSegment(spPos, gazePos, lift),
            ...arcSegment(gazePos, meshPos, lift).slice(1),
          ];
          const isActive = ribbonActive(r);
          const [cr, cg, cb] = heatRgb(intensity);
          const tube = MeshBuilder.CreateTube(
            `ts-link-${r.standpointId}-${r.gazeId}-${r.meshId}`,
            {
              path,
              radius: (isActive ? 1 : 0.4) * (0.012 + 0.04 * intensity),
              tessellation: 8,
              cap: 0,
              sideOrientation: 0,
            },
            scene,
          );
          const mat = new StandardMaterial(
            `ts-link-mat-${r.standpointId}-${r.gazeId}-${r.meshId}`,
            scene,
          );
          mat.disableLighting = true;
          mat.emissiveColor = new Color3(cr, cg, cb);
          mat.alpha = isActive ? 0.35 + 0.65 * intensity : anyFocus ? 0.06 : 0.18;
          tube.material = mat;
          tube.isPickable = true;
          tube.metadata = { hoverLabel: labelById.get(r.meshId) ?? r.meshId };
        }

        const tsCenter = Vector3.Zero();
        const camera = new ArcRotateCamera(
          "ts-cam",
          Math.PI / 2,
          Math.PI / 2.4,
          8.5,
          tsCenter,
          scene,
        );
        camera.attachControl(canvas, true);
        disableWheelZoom(camera);
        cameraRef.current = camera;
        homeRef.current = {
          target: tsCenter,
          alpha: camera.alpha,
          beta: camera.beta,
          radius: camera.radius,
        };
        new HemisphericLight("ts-light", new Vector3(0.3, 1, 0.2), scene);

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
        setError(err instanceof Error ? err.message : "Failed to render flow links.");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [isTwoStage, twoStage, standpointFocus, sourceFocus, meshFocus]);

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
          <div className="absolute left-3 top-3 flex flex-wrap gap-2">
            {hasStandpoints ? (
              <div className="flex items-center gap-1 rounded-md border border-edge bg-ink/80 p-0.5 text-xs backdrop-blur">
                <ViewToggleButton active={!isTwoStage} onClick={() => setViewMode("aggregate")}>
                  Aggregate
                </ViewToggleButton>
                <ViewToggleButton active={isTwoStage} onClick={() => setViewMode("twostage")}>
                  Two-stage
                </ViewToggleButton>
              </div>
            ) : null}
            {selfFetch ? (
              <div className="flex items-center gap-1 rounded-md border border-edge bg-ink/80 p-0.5 text-xs backdrop-blur">
                <ViewToggleButton
                  active={cameraMode === "first-person"}
                  onClick={() => setCameraMode("first-person")}
                >
                  Walk
                </ViewToggleButton>
                <ViewToggleButton
                  active={cameraMode === "viewer"}
                  onClick={() => setCameraMode("viewer")}
                  disabled={hasFirstPerson}
                  title={
                    hasFirstPerson
                      ? "Orbit (viewer) flow isn't available for walkable scenes"
                      : undefined
                  }
                >
                  Orbit
                </ViewToggleButton>
                <ViewToggleButton
                  active={cameraMode === "all"}
                  onClick={() => setCameraMode("all")}
                >
                  All
                </ViewToggleButton>
              </div>
            ) : null}
            {hasStandpoints ? (
              <FlowSelect
                label="Standpoint"
                value={standpointFocus}
                onChange={setStandpointFocus}
                allLabel="All standpoints"
                options={standpointOptions}
              />
            ) : null}
            <FlowSelect
              label={isTwoStage ? "Gaze" : "Source"}
              value={sourceFocus}
              onChange={setSourceFocus}
              allLabel={isTwoStage ? "All gaze sectors" : "All sources"}
              options={gazeOptions}
            />
            <FlowSelect
              label="Mesh"
              value={meshFocus}
              onChange={setMeshFocus}
              allLabel="All meshes"
              options={meshOptions}
            />
          </div>
          {isTwoStage ? (
            <StandpointMinimap
              standpoints={standpoints}
              proxyMeshes={proxyMeshes}
              selectedKey={standpointFocus}
              onSelect={(key) => setStandpointFocus((cur) => (cur === key ? ALL : key))}
            />
          ) : null}
          <div className="pointer-events-none absolute bottom-3 right-3 flex max-w-[20rem] flex-col items-end gap-2">
            {selfFetch && !hasFirstPerson ? (
              <div className="rounded-md border border-edge bg-ink/80 px-2 py-1 text-xs text-fg-muted backdrop-blur">
                Orbit-dominated scene — viewer <em>position</em> adds little here. Use the{" "}
                <strong>View dome</strong> (§7.5) above for where viewers looked.
              </div>
            ) : null}
            <div className="rounded-md border border-edge bg-ink/80 px-2 py-1 text-xs text-fg backdrop-blur">
              Active links: {activeCount}/{totalCount}
            </div>
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
            title="Flow volume"
            lowLabel="fewer links"
            highLabel="dominant links"
            note={
              isTwoStage
                ? "Three columns: standpoint → gaze sector → mesh. Top standpoints/meshes are kept; the tail folds into an “Other” node. Pick a standpoint (or click the minimap), gaze sector, or mesh to emphasize matching ribbons."
                : "Each arc aggregates clicks from one camera-direction bin to a mesh. Pick a source or mesh to emphasize matching links and dim the rest."
            }
          />
        </>
      ) : (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-fg-muted">
          {phase === "loading"
            ? "Rendering…"
            : phase === "empty"
              ? "No aggregate flow links in range."
              : phase === "error"
                ? (error ?? "Flow view unavailable.")
                : null}
        </div>
      )}
    </div>
  );
}

export const FLOW_SANKEY_TITLE = "Flow Sankey (3D)";
export const FLOW_SANKEY_SUBTITLE =
  "Direction-bin → mesh links (aggregate), or standpoint → gaze → mesh (two-stage) — double-click to focus";

/** "?" help content shared by the chrome wrapper and the registered panel. */
export const FLOW_SANKEY_HELP = (
  <>
    Each <strong>source</strong> is a camera <em>gaze-direction bin</em> — a cell on the sphere of
    where viewers were looking (grouped by azimuth/elevation). Each <strong>target</strong> is a{" "}
    <em>mesh that was clicked</em>. A ribbon&apos;s thickness is how many clicks on that mesh
    happened while viewers looked from that direction, so you can see which viewpoints drive
    interaction with which objects. When the scene reports <em>standpoints</em> (where the viewer
    stood, §7.8), pick one to gate the flow to clicks made from that vantage — a pin marks it in the
    scene. &quot;All standpoints&quot; is the aggregate view. Switch to <strong>Two-stage</strong>{" "}
    for a three-column <em>standpoint → gaze sector → mesh</em> flow with a birdview minimap; the
    busiest standpoints/meshes are kept and the tail folds into an &quot;Other&quot; node.
  </>
);

/** Chrome-wrapped flow Sankey for legacy call sites (overview surface). */
export function FlowSankey3D(props: Parameters<typeof FlowSankey3DView>[0]) {
  return (
    <Panel title={FLOW_SANKEY_TITLE} subtitle={FLOW_SANKEY_SUBTITLE} help={FLOW_SANKEY_HELP}>
      <FlowSankey3DView {...props} />
    </Panel>
  );
}

function FlowSelect({
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

function ViewToggleButton({
  active,
  onClick,
  children,
  disabled = false,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded px-2 py-0.5 font-medium transition ${
        disabled
          ? "cursor-not-allowed text-fg-muted/40"
          : active
            ? "bg-amber text-ink"
            : "text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Birdview (XZ-plane) minimap of the standpoint voxels over the proxy-mesh
 * footprints (§7.8 slice 3). Lets the left column read spatially and supports
 * click-to-pick of a standpoint.
 */
function StandpointMinimap({
  standpoints,
  proxyMeshes,
  selectedKey,
  onSelect,
}: {
  standpoints: FlowStandpoint[];
  proxyMeshes: SceneProxyMesh[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const W = 150;
  const H = 110;
  const pad = 8;

  const placed = useMemo(() => standpoints.filter((s) => s.origin), [standpoints]);

  const bounds = useMemo(() => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const consider = (x: number, z: number) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    };
    for (const m of proxyMeshes) {
      consider(m.aabb[0], m.aabb[2]);
      consider(m.aabb[3], m.aabb[5]);
    }
    for (const s of placed) consider(s.origin![0], s.origin![2]);
    if (!Number.isFinite(minX)) return { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
    if (maxX - minX < 1e-3) {
      minX -= 1;
      maxX += 1;
    }
    if (maxZ - minZ < 1e-3) {
      minZ -= 1;
      maxZ += 1;
    }
    return { minX, maxX, minZ, maxZ };
  }, [proxyMeshes, placed]);

  const toPx = useMemo(() => {
    const sx = (W - pad * 2) / (bounds.maxX - bounds.minX);
    const sz = (H - pad * 2) / (bounds.maxZ - bounds.minZ);
    const s = Math.min(sx, sz);
    return (x: number, z: number): [number, number] => [
      pad + (x - bounds.minX) * s,
      pad + (z - bounds.minZ) * s,
    ];
  }, [bounds]);

  const maxCount = useMemo(() => placed.reduce((m, s) => Math.max(m, s.count), 1), [placed]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas!.width = W * dpr;
    canvas!.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(8,10,14,0.85)";
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(120,140,170,0.35)";
    ctx.lineWidth = 1;
    for (const m of proxyMeshes) {
      const [x0, y0] = toPx(m.aabb[0], m.aabb[2]);
      const [x1, y1] = toPx(m.aabb[3], m.aabb[5]);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    }

    for (const s of placed) {
      const [px, py] = toPx(s.origin![0], s.origin![2]);
      const r = 2 + (s.count / maxCount) * 4;
      const selected = s.key === selectedKey;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = selected ? "rgba(242,115,242,1)" : "rgba(242,115,242,0.55)";
      ctx.fill();
      if (selected) {
        ctx.beginPath();
        ctx.arc(px, py, r + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }, [proxyMeshes, placed, toPx, maxCount, selectedKey]);

  const handleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = ref.current;
    if (!canvas || placed.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const my = ((e.clientY - rect.top) / rect.height) * H;
    let best: FlowStandpoint | null = null;
    let bestD = Infinity;
    for (const s of placed) {
      const [px, py] = toPx(s.origin![0], s.origin![2]);
      const d = (px - mx) ** 2 + (py - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best && bestD <= 14 * 14) onSelect(best.key);
  };

  return (
    <div className="absolute right-3 top-3 rounded-md border border-edge bg-ink/80 p-1 backdrop-blur">
      <div className="px-1 pb-0.5 text-[10px] font-medium text-fg-muted">
        Standpoints (top view)
      </div>
      <canvas ref={ref} className="h-27.5 w-37.5 cursor-pointer rounded" onClick={handleClick} />
    </div>
  );
}
