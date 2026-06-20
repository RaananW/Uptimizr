import { Vector3, Color3, MeshBuilder, StandardMaterial, type Mesh } from "@babylonjs/core/pure";
import { heatRgb } from "./heat.js";
import { PROXY_MESHES, makeFlowLinks, meshCenter } from "./data.js";
import type { DemoContext, DemoTab } from "./types.js";

/** Mirror of the dashboard's FlowSankey3D: gaze-direction → clicked-mesh ribbons. */
export function createFlowTab(): DemoTab {
  const gridSize = 16;
  const meshes: Mesh[] = [];
  let dome: Mesh | null = null;
  let center = Vector3.Zero();
  let sourceRadius = 2;

  const setEnabled = (on: boolean): void => {
    dome?.setEnabled(on);
    for (const m of meshes) m.setEnabled(on);
  };

  return {
    id: "flow",
    label: "Flow Sankey",
    badge: "flow Sankey (3D) · gaze-direction → clicked-mesh links",
    hint: "Each ribbon links a gaze-direction bin (blue, on the dome) to a mesh that got clicked (amber) — thickness and color scale with how many clicks came from that viewpoint.",
    build(ctx: DemoContext) {
      const { scene } = ctx;
      const links = makeFlowLinks(gridSize);
      const maxCount = links.reduce((m, l) => Math.max(m, l.count), 1);

      const targetByMesh = new Map<string, Vector3>();
      for (const pm of PROXY_MESHES) {
        const [x, y, z] = meshCenter(pm.aabb);
        targetByMesh.set(pm.name, new Vector3(x, y, z));
      }
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const p of targetByMesh.values()) {
        cx += p.x;
        cy += p.y;
        cz += p.z;
      }
      center = new Vector3(cx / targetByMesh.size, cy / targetByMesh.size, cz / targetByMesh.size);
      let extent = 1.6;
      for (const p of targetByMesh.values()) extent = Math.max(extent, Vector3.Distance(p, center));
      sourceRadius = extent * 0.9 + 1;

      const srcMat = new StandardMaterial("flow-src", scene);
      srcMat.disableLighting = true;
      srcMat.emissiveColor = new Color3(0.45, 0.75, 1);
      const tgtMat = new StandardMaterial("flow-tgt", scene);
      tgtMat.disableLighting = true;
      tgtMat.emissiveColor = new Color3(1, 0.82, 0.42);

      const srcSeen = new Set<string>();
      const tgtSeen = new Set<string>();
      for (const link of links) {
        const dst = targetByMesh.get(link.mesh);
        if (!dst) continue;
        const key = `${link.az}|${link.el}`;
        const az = ((link.az + 0.5) / gridSize) * Math.PI * 2 - Math.PI;
        const el = ((link.el + 0.5) / gridSize) * Math.PI - Math.PI / 2;
        const ce = Math.cos(el);
        const src = new Vector3(
          center.x + ce * Math.cos(az) * sourceRadius,
          center.y + Math.sin(el) * sourceRadius,
          center.z + ce * Math.sin(az) * sourceRadius,
        );

        if (!srcSeen.has(key)) {
          const s = MeshBuilder.CreateSphere(`flow-src-${key}`, { diameter: 0.12, segments: 6 }, scene);
          s.position = src;
          s.material = srcMat;
          s.isPickable = false;
          meshes.push(s);
          srcSeen.add(key);
        }
        if (!tgtSeen.has(link.mesh)) {
          const t = MeshBuilder.CreateSphere(`flow-tgt-${link.mesh}`, { diameter: 0.2, segments: 8 }, scene);
          t.position = dst.clone();
          t.material = tgtMat;
          t.isPickable = false;
          meshes.push(t);
          tgtSeen.add(link.mesh);
        }

        const intensity = link.count / maxCount;
        const mid = src.add(dst).scale(0.5);
        const fromCenter = mid.subtract(center);
        const len = fromCenter.length();
        const nrm = len > 1e-6 ? fromCenter.scale(1 / len) : new Vector3(0, 1, 0);
        const lift = 0.35 + intensity * 0.75;
        const ctrl = new Vector3(mid.x + nrm.x * lift, mid.y + nrm.y * lift + 0.12, mid.z + nrm.z * lift);
        const path: Vector3[] = [];
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
        const [r, g, b] = heatRgb(intensity);
        const tube = MeshBuilder.CreateTube(
          `flow-link-${key}-${link.mesh}`,
          { path, radius: 0.012 + 0.04 * intensity, tessellation: 8, cap: 0 },
          scene,
        );
        const tm = new StandardMaterial(`flow-link-mat-${key}-${link.mesh}`, scene);
        tm.disableLighting = true;
        tm.emissiveColor = new Color3(r, g, b);
        tm.alpha = 0.35 + 0.65 * intensity;
        tube.material = tm;
        tube.isPickable = false;
        meshes.push(tube);
      }

      dome = MeshBuilder.CreateSphere("flow-dome", { diameter: sourceRadius * 2, segments: 20 }, scene);
      dome.position = center.clone();
      const dm = new StandardMaterial("flow-dome-mat", scene);
      dm.wireframe = true;
      dm.disableLighting = true;
      dm.emissiveColor = new Color3(0.16, 0.2, 0.28);
      dm.alpha = 0.35;
      dome.material = dm;
      dome.isPickable = false;
      setEnabled(false);
    },
    enter(ctx: DemoContext) {
      setEnabled(true);
      const cam = ctx.camera;
      cam.lowerRadiusLimit = sourceRadius * 1.3;
      cam.upperRadiusLimit = sourceRadius * 6;
      cam.target.copyFrom(center);
      cam.radius = sourceRadius * 2.7;
      cam.alpha = Math.PI / 4;
      cam.beta = Math.PI / 3;
    },
    exit() {
      setEnabled(false);
    },
    update(ctx: DemoContext) {
      if (!ctx.reduced) ctx.camera.alpha += 0.0012;
    },
  };
}
