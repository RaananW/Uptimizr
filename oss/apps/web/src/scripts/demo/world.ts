import { Vector3, Color3, Matrix, MeshBuilder, StandardMaterial, type Mesh } from "@babylonjs/core/pure";
import { heatRgb } from "./heat.js";
import { makeVoxels } from "./data.js";
import { buildProxyBoxes } from "./meshes.js";
import type { DemoContext, DemoTab } from "./types.js";

/** Mirror of the dashboard's WorldHeatmap3D: voxel-binned pointer density. */
export function createWorldTab(): DemoTab {
  const cellSize = 0.18;
  let proxy: Mesh | null = null;
  let marker: Mesh | null = null;
  let center = Vector3.Zero();
  let radius = 1;

  const setEnabled = (on: boolean): void => {
    proxy?.setEnabled(on);
    marker?.setEnabled(on);
  };

  return {
    id: "world",
    label: "World heatmap",
    badge: "world heatmap (3D) · pointer-hit density on your scene",
    hint: "Every pointer hit is voxel-binned in world space and colored by density — the busiest cells glow hottest, exactly like the dashboard's World heatmap panel.",
    build(ctx: DemoContext) {
      const { scene } = ctx;
      proxy = buildProxyBoxes(scene, "world-proxy");

      const voxels = makeVoxels(cellSize);
      const maxCount = voxels.reduce((m, v) => Math.max(m, v.count), 1);
      marker = MeshBuilder.CreateSphere("world-voxel", { diameter: cellSize * 0.9, segments: 6 }, scene);
      const mat = new StandardMaterial("world-voxel-mat", scene);
      mat.specularColor = new Color3(0, 0, 0);
      mat.emissiveColor = new Color3(0.12, 0.12, 0.12);
      marker.material = mat;
      marker.isPickable = false;

      const n = voxels.length;
      const matrices = new Float32Array(n * 16);
      const colors = new Float32Array(n * 4);
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let i = 0; i < n; i++) {
        const v = voxels[i]!;
        const t = v.count / maxCount;
        const s = 0.35 + 0.65 * t;
        const px = (v.vx + 0.5) * cellSize;
        const py = (v.vy + 0.5) * cellSize;
        const pz = (v.vz + 0.5) * cellSize;
        Matrix.Scaling(s, s, s).multiply(Matrix.Translation(px, py, pz)).copyToArray(matrices, i * 16);
        const [r, g, b] = heatRgb(t);
        colors[i * 4] = r;
        colors[i * 4 + 1] = g;
        colors[i * 4 + 2] = b;
        colors[i * 4 + 3] = 1;
        cx += px;
        cy += py;
        cz += pz;
      }
      marker.thinInstanceSetBuffer("matrix", matrices, 16, true);
      marker.thinInstanceSetBuffer("color", colors, 4, true);

      center = new Vector3(cx / n, cy / n, cz / n);
      radius = cellSize * 4;
      for (const v of voxels) {
        const dx = (v.vx + 0.5) * cellSize - center.x;
        const dy = (v.vy + 0.5) * cellSize - center.y;
        const dz = (v.vz + 0.5) * cellSize - center.z;
        radius = Math.max(radius, Math.hypot(dx, dy, dz));
      }
      setEnabled(false);
    },
    enter(ctx: DemoContext) {
      setEnabled(true);
      const cam = ctx.camera;
      cam.lowerRadiusLimit = radius * 1.2;
      cam.upperRadiusLimit = radius * 5;
      cam.target.copyFrom(center);
      cam.radius = radius * 2.6;
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
