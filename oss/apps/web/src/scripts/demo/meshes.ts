import { Color3, Matrix, MeshBuilder, StandardMaterial, type Mesh, type Scene } from "@babylonjs/core/pure";
import { PROXY_MESHES } from "./data.js";

/**
 * The faint blue-grey wireframe proxy boxes the dashboard draws behind every
 * spatial panel — one thin-instanced box mesh standing in for the user's scene.
 */
export function buildProxyBoxes(scene: Scene, name: string): Mesh {
  const box = MeshBuilder.CreateBox(name, { size: 1 }, scene);
  const mat = new StandardMaterial(`${name}-mat`, scene);
  mat.wireframe = true;
  mat.disableLighting = true;
  mat.emissiveColor = new Color3(0.32, 0.4, 0.52);
  mat.alpha = 0.35;
  box.material = mat;
  box.isPickable = false;

  const matrices = new Float32Array(PROXY_MESHES.length * 16);
  for (let i = 0; i < PROXY_MESHES.length; i++) {
    const a = PROXY_MESHES[i]!.aabb;
    const sx = Math.max(a[3] - a[0], 1e-3);
    const sy = Math.max(a[4] - a[1], 1e-3);
    const sz = Math.max(a[5] - a[2], 1e-3);
    Matrix.Scaling(sx, sy, sz)
      .multiply(Matrix.Translation((a[0] + a[3]) / 2, (a[1] + a[4]) / 2, (a[2] + a[5]) / 2))
      .copyToArray(matrices, i * 16);
  }
  box.thinInstanceSetBuffer("matrix", matrices, 16, true);
  return box;
}
