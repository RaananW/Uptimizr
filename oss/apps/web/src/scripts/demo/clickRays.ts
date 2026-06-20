import {
  Vector3,
  Color3,
  Color4,
  Matrix,
  MeshBuilder,
  StandardMaterial,
  type LinesMesh,
  type Mesh,
} from "@babylonjs/core/pure";
import { heatRgb } from "./heat.js";
import { makeRays } from "./data.js";
import { buildProxyBoxes } from "./meshes.js";
import type { DemoContext, DemoTab } from "./types.js";

/** Mirror of the dashboard's ClickRays3D: clicks joined to the view they came from. */
export function createClickRaysTab(): DemoTab {
  let proxy: Mesh | null = null;
  let lines: LinesMesh | null = null;
  let eye: Mesh | null = null;
  let center = Vector3.Zero();
  let radius = 1;

  const setEnabled = (on: boolean): void => {
    proxy?.setEnabled(on);
    lines?.setEnabled(on);
    eye?.setEnabled(on);
  };

  return {
    id: "clicks",
    label: "Click rays",
    badge: "click rays (3D) · each click joined to the view it came from",
    hint: "Every click is a ray from the camera position (bright eye) to the exact surface point it hit — correlating what people clicked with where they were looking from.",
    build(ctx: DemoContext) {
      const { scene } = ctx;
      proxy = buildProxyBoxes(scene, "cr-proxy");

      const rays = makeRays();
      const maxCount = rays.reduce((m, r) => Math.max(m, r.count), 1);
      const segments: Vector3[][] = [];
      const segmentColors: Color4[][] = [];
      const eyes = new Map<string, [number, number, number]>();
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let pointCount = 0;
      for (const ray of rays) {
        const t = ray.count / maxCount;
        const [r, g, b] = heatRgb(t);
        const c = new Color4(r, g, b, 0.35 + 0.65 * t);
        segments.push([new Vector3(...ray.origin), new Vector3(...ray.hit)]);
        segmentColors.push([c, c]);
        eyes.set(ray.origin.join(","), ray.origin);
        cx += ray.origin[0] + ray.hit[0];
        cy += ray.origin[1] + ray.hit[1];
        cz += ray.origin[2] + ray.hit[2];
        pointCount += 2;
      }
      lines = MeshBuilder.CreateLineSystem(
        "cr-lines",
        { lines: segments, colors: segmentColors, useVertexAlpha: true },
        scene,
      );
      lines.isPickable = false;

      eye = MeshBuilder.CreateSphere("cr-eye", { diameter: 0.12, segments: 6 }, scene);
      const em = new StandardMaterial("cr-eye-mat", scene);
      em.disableLighting = true;
      em.emissiveColor = new Color3(0.9, 0.95, 1);
      eye.material = em;
      eye.isPickable = false;
      const eyeList = [...eyes.values()];
      const eyeMatrices = new Float32Array(eyeList.length * 16);
      for (let i = 0; i < eyeList.length; i++) {
        const v = eyeList[i]!;
        Matrix.Translation(v[0], v[1], v[2]).copyToArray(eyeMatrices, i * 16);
      }
      eye.thinInstanceSetBuffer("matrix", eyeMatrices, 16, true);

      center = new Vector3(cx / pointCount, cy / pointCount, cz / pointCount);
      radius = 1;
      for (const ray of rays) {
        for (const p of [ray.origin, ray.hit]) {
          radius = Math.max(radius, Math.hypot(p[0] - center.x, p[1] - center.y, p[2] - center.z));
        }
      }
      setEnabled(false);
    },
    enter(ctx: DemoContext) {
      setEnabled(true);
      const cam = ctx.camera;
      cam.lowerRadiusLimit = radius * 1.1;
      cam.upperRadiusLimit = radius * 5;
      cam.target.copyFrom(center);
      cam.radius = radius * 2.4;
      cam.alpha = Math.PI / 4;
      cam.beta = Math.PI / 3;
    },
    exit() {
      setEnabled(false);
    },
    update(ctx: DemoContext) {
      if (!ctx.reduced) ctx.camera.alpha += 0.0014;
    },
  };
}
