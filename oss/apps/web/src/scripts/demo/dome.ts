import {
  Vector3,
  Color3,
  Matrix,
  MeshBuilder,
  StandardMaterial,
  type LinesMesh,
  type Mesh,
} from "@babylonjs/core/pure";
import { heatRgb } from "./heat.js";
import { makeDirectionBins } from "./data.js";
import type { DemoContext, DemoTab } from "./types.js";

/** Mirror of the dashboard's CameraDome3D: view directions mapped onto a sphere. */
export function createDomeTab(): DemoTab {
  const gridSize = 16;
  let dome: Mesh | null = null;
  let horizon: LinesMesh | null = null;
  let forward: LinesMesh | null = null;
  let marker: Mesh | null = null;

  const setEnabled = (on: boolean): void => {
    dome?.setEnabled(on);
    horizon?.setEnabled(on);
    forward?.setEnabled(on);
    marker?.setEnabled(on);
  };

  return {
    id: "dome",
    label: "View dome",
    badge: "view-direction dome (3D) · where the audience looked",
    hint: "Each marker is a camera look-direction mapped onto a sphere — the blue line is forward, the ring is the horizon. Size and color scale with how often that direction was viewed.",
    build(ctx: DemoContext) {
      const { scene } = ctx;
      dome = MeshBuilder.CreateSphere("dome", { diameter: 2, segments: 20 }, scene);
      const dm = new StandardMaterial("dome-mat", scene);
      dm.wireframe = true;
      dm.disableLighting = true;
      dm.emissiveColor = new Color3(0.16, 0.2, 0.28);
      dm.alpha = 0.5;
      dome.material = dm;
      dome.isPickable = false;

      const ringPts: Vector3[] = [];
      const seg = 64;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        ringPts.push(new Vector3(Math.cos(a), 0, Math.sin(a)));
      }
      horizon = MeshBuilder.CreateLines("dome-horizon", { points: ringPts }, scene);
      horizon.color = new Color3(0.3, 0.36, 0.46);
      horizon.isPickable = false;

      forward = MeshBuilder.CreateLines(
        "dome-forward",
        { points: [Vector3.Zero(), new Vector3(1.25, 0, 0)] },
        scene,
      );
      forward.color = new Color3(0.4, 0.7, 0.95);
      forward.isPickable = false;

      const bins = makeDirectionBins(gridSize);
      const maxCount = bins.reduce((m, b) => Math.max(m, b.count), 1);
      marker = MeshBuilder.CreateBox("dome-marker", { size: 1 }, scene);
      const bm = new StandardMaterial("dome-marker-mat", scene);
      bm.disableLighting = true;
      bm.emissiveColor = Color3.White();
      bm.specularColor = new Color3(0, 0, 0);
      marker.material = bm;
      marker.isPickable = false;

      const n = bins.length;
      const matrices = new Float32Array(n * 16);
      const colors = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const b = bins[i]!;
        const az = ((b.az + 0.5) / gridSize) * Math.PI * 2 - Math.PI;
        const el = ((b.el + 0.5) / gridSize) * Math.PI - Math.PI / 2;
        const ce = Math.cos(el);
        const dx = ce * Math.cos(az);
        const dy = Math.sin(el);
        const dz = ce * Math.sin(az);
        const t = b.count / maxCount;
        const s = 0.03 + 0.12 * t;
        Matrix.Scaling(s, s, s).multiply(Matrix.Translation(dx, dy, dz)).copyToArray(matrices, i * 16);
        const [r, g, bl] = heatRgb(t);
        colors[i * 4] = r;
        colors[i * 4 + 1] = g;
        colors[i * 4 + 2] = bl;
        colors[i * 4 + 3] = 1;
      }
      marker.thinInstanceSetBuffer("matrix", matrices, 16, true);
      marker.thinInstanceSetBuffer("color", colors, 4, true);
      setEnabled(false);
    },
    enter(ctx: DemoContext) {
      setEnabled(true);
      const cam = ctx.camera;
      cam.lowerRadiusLimit = 1.6;
      cam.upperRadiusLimit = 8;
      cam.target.set(0, 0, 0);
      cam.radius = 3.6;
      cam.alpha = Math.PI / 3;
      cam.beta = Math.PI / 2.4;
    },
    exit() {
      setEnabled(false);
    },
    update(ctx: DemoContext) {
      if (!ctx.reduced) ctx.camera.alpha += 0.0012;
    },
  };
}
