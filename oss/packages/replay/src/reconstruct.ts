/**
 * Proxy-driven **rigid** reconstruction (ADR 0033 §3).
 *
 * When an actor is captured Tier-1 root-only (one `node_transform` stream, no
 * `childPath`) and a scene proxy ({@link ../../schema} `sceneProxySchema`) carries
 * per-mesh hierarchy (`path`) plus a scan-time world transform (`world`), replay
 * can move the actor's whole sub-assembly **rigidly** with the recorded root —
 * reproducing "parenting just works" without capturing or listing any child:
 *
 * ```
 * childWorld(t) = rootWorld(t) · rootWorld(t0)⁻¹ · childWorldAtScan
 * ```
 *
 * This is **rigid only**: it reproduces motion that is rigid w.r.t. the root. It
 * must never be used to fake internal articulation — for that, the developer opts
 * into Tier-1 subtree capture (ADR 0033 §1) and replay drives each captured
 * `childPath` directly. Callers MUST prefer a captured `childPath` sample over a
 * reconstructed transform whenever one exists.
 *
 * The math here is pure, engine-agnostic, column-major 4×4 (the three.js layout,
 * matching the connector decompose path) and operates entirely in the canonical
 * frame (ADR 0018), so it is independent of the source engine's handedness.
 */
import type { MeshTransform, SceneProxy } from "@uptimizr/schema";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** A fully-specified world transform (position, rotation quaternion, scale). */
export interface RigidTransform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** A recorded or current root world transform; scale defaults to identity. */
export interface RootTransform {
  position: Vec3;
  rotation: Quat;
  scale?: Vec3;
}

/** A reconstructed descendant: its proxy name/path and the world transform at `t`. */
export interface ReconstructedMesh {
  name: string;
  path: string;
  world: RigidTransform;
}

type Mat4 = number[]; // length 16, column-major (element[col*4 + row])

/** Compose a column-major 4×4 from position / rotation quaternion / scale. */
function compose(position: Vec3, q: Quat, scale: Vec3): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2;
  const yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  const [sx, sy, sz] = scale;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    position[0],
    position[1],
    position[2],
    1,
  ];
}

/** Column-major matrix product `a · b`. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const a11 = a[0]!,
    a12 = a[4]!,
    a13 = a[8]!,
    a14 = a[12]!;
  const a21 = a[1]!,
    a22 = a[5]!,
    a23 = a[9]!,
    a24 = a[13]!;
  const a31 = a[2]!,
    a32 = a[6]!,
    a33 = a[10]!,
    a34 = a[14]!;
  const a41 = a[3]!,
    a42 = a[7]!,
    a43 = a[11]!,
    a44 = a[15]!;
  const b11 = b[0]!,
    b12 = b[4]!,
    b13 = b[8]!,
    b14 = b[12]!;
  const b21 = b[1]!,
    b22 = b[5]!,
    b23 = b[9]!,
    b24 = b[13]!;
  const b31 = b[2]!,
    b32 = b[6]!,
    b33 = b[10]!,
    b34 = b[14]!;
  const b41 = b[3]!,
    b42 = b[7]!,
    b43 = b[11]!,
    b44 = b[15]!;
  return [
    a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41,
    a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41,
    a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41,
    a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41,
    a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42,
    a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42,
    a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42,
    a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42,
    a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43,
    a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43,
    a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43,
    a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43,
    a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44,
    a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44,
    a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44,
    a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44,
  ];
}

/** Inverse of a column-major 4×4 (three.js `Matrix4.invert`); `null` if singular. */
function invert(m: Mat4): Mat4 | null {
  const n11 = m[0]!,
    n21 = m[1]!,
    n31 = m[2]!,
    n41 = m[3]!;
  const n12 = m[4]!,
    n22 = m[5]!,
    n32 = m[6]!,
    n42 = m[7]!;
  const n13 = m[8]!,
    n23 = m[9]!,
    n33 = m[10]!,
    n43 = m[11]!;
  const n14 = m[12]!,
    n24 = m[13]!,
    n34 = m[14]!,
    n44 = m[15]!;
  const t11 =
    n23 * n34 * n42 -
    n24 * n33 * n42 +
    n24 * n32 * n43 -
    n22 * n34 * n43 -
    n23 * n32 * n44 +
    n22 * n33 * n44;
  const t12 =
    n14 * n33 * n42 -
    n13 * n34 * n42 -
    n14 * n32 * n43 +
    n12 * n34 * n43 +
    n13 * n32 * n44 -
    n12 * n33 * n44;
  const t13 =
    n13 * n24 * n42 -
    n14 * n23 * n42 +
    n14 * n22 * n43 -
    n12 * n24 * n43 -
    n13 * n22 * n44 +
    n12 * n23 * n44;
  const t14 =
    n14 * n23 * n32 -
    n13 * n24 * n32 -
    n14 * n22 * n33 +
    n12 * n24 * n33 +
    n13 * n22 * n34 -
    n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (det === 0) return null;
  const idet = 1 / det;
  return [
    t11 * idet,
    (n24 * n33 * n41 -
      n23 * n34 * n41 -
      n24 * n31 * n43 +
      n21 * n34 * n43 +
      n23 * n31 * n44 -
      n21 * n33 * n44) *
      idet,
    (n22 * n34 * n41 -
      n24 * n32 * n41 +
      n24 * n31 * n42 -
      n21 * n34 * n42 -
      n22 * n31 * n44 +
      n21 * n32 * n44) *
      idet,
    (n23 * n32 * n41 -
      n22 * n33 * n41 -
      n23 * n31 * n42 +
      n21 * n33 * n42 +
      n22 * n31 * n43 -
      n21 * n32 * n43) *
      idet,
    t12 * idet,
    (n13 * n34 * n41 -
      n14 * n33 * n41 +
      n14 * n31 * n43 -
      n11 * n34 * n43 -
      n13 * n31 * n44 +
      n11 * n33 * n44) *
      idet,
    (n14 * n32 * n41 -
      n12 * n34 * n41 -
      n14 * n31 * n42 +
      n11 * n34 * n42 +
      n12 * n31 * n44 -
      n11 * n32 * n44) *
      idet,
    (n12 * n33 * n41 -
      n13 * n32 * n41 +
      n13 * n31 * n42 -
      n11 * n33 * n42 -
      n12 * n31 * n43 +
      n11 * n32 * n43) *
      idet,
    t13 * idet,
    (n14 * n23 * n41 -
      n13 * n24 * n41 -
      n14 * n21 * n43 +
      n11 * n24 * n43 +
      n13 * n21 * n44 -
      n11 * n23 * n44) *
      idet,
    (n12 * n24 * n41 -
      n14 * n22 * n41 +
      n14 * n21 * n42 -
      n11 * n24 * n42 -
      n12 * n21 * n44 +
      n11 * n22 * n44) *
      idet,
    (n13 * n22 * n41 -
      n12 * n23 * n41 -
      n13 * n21 * n42 +
      n11 * n23 * n42 +
      n12 * n21 * n43 -
      n11 * n22 * n43) *
      idet,
    t14 * idet,
    (n13 * n24 * n31 -
      n14 * n23 * n31 +
      n14 * n21 * n33 -
      n11 * n24 * n33 -
      n13 * n21 * n34 +
      n11 * n23 * n34) *
      idet,
    (n14 * n22 * n31 -
      n12 * n24 * n31 -
      n14 * n21 * n32 +
      n11 * n24 * n32 +
      n12 * n21 * n34 -
      n11 * n22 * n34) *
      idet,
    (n12 * n23 * n31 -
      n13 * n22 * n31 +
      n13 * n21 * n32 -
      n11 * n23 * n32 -
      n12 * n21 * n33 +
      n11 * n22 * n33) *
      idet,
  ];
}

/** Decompose a column-major 4×4 into position / rotation quaternion / scale. */
function decompose(e: Mat4): RigidTransform {
  const position: Vec3 = [e[12]!, e[13]!, e[14]!];
  let sx = Math.hypot(e[0]!, e[1]!, e[2]!);
  const sy = Math.hypot(e[4]!, e[5]!, e[6]!);
  const sz = Math.hypot(e[8]!, e[9]!, e[10]!);
  const det =
    e[0]! * (e[5]! * e[10]! - e[6]! * e[9]!) -
    e[4]! * (e[1]! * e[10]! - e[2]! * e[9]!) +
    e[8]! * (e[1]! * e[6]! - e[2]! * e[5]!);
  if (det < 0) sx = -sx;
  const ix = sx !== 0 ? 1 / sx : 0;
  const iy = sy !== 0 ? 1 / sy : 0;
  const iz = sz !== 0 ? 1 / sz : 0;
  const m11 = e[0]! * ix,
    m21 = e[1]! * ix,
    m31 = e[2]! * ix;
  const m12 = e[4]! * iy,
    m22 = e[5]! * iy,
    m32 = e[6]! * iy;
  const m13 = e[8]! * iz,
    m23 = e[9]! * iz,
    m33 = e[10]! * iz;
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }
  return { position, rotation: [x, y, z, w], scale: [sx, sy, sz] };
}

function transformMat4(t: { position: Vec3; rotation: Quat; scale?: Vec3 }): Mat4 {
  return compose(t.position, t.rotation, t.scale ?? [1, 1, 1]);
}

/** Options for {@link reconstructRigidSubtree}. */
export interface ReconstructRigidSubtreeOptions {
  /** The scene proxy carrying per-mesh `path` + scan-time `world` (ADR 0033 §3). */
  proxy: SceneProxy;
  /**
   * The proxy node path of the actor's root, e.g. `"Machine_root"`. Descendant
   * meshes are those whose `path` is `rootPath/...`. Matched by exact path prefix.
   */
  rootPath: string;
  /** The actor's **current** (time-`t`) root world transform, from the recorded stream. */
  rootWorld: RootTransform;
  /**
   * The actor's root world transform at scan time (`t0`). Defaults to the proxy
   * mesh whose `path` equals `rootPath`. Reconstruction is unavailable (returns
   * `[]`) when neither is present.
   */
  rootWorldAtScan?: MeshTransform;
}

/**
 * Reconstruct the world transforms of an actor's rigid sub-assembly at time `t`
 * from a single recorded root transform and the scene proxy's scan-time snapshot.
 * Returns one entry per descendant proxy mesh that carries `path` + `world`;
 * meshes without those fields, and the root itself, are skipped. Returns `[]` when
 * the proxy has no usable scan-time root transform.
 *
 * Callers MUST prefer a captured `childPath` sample over these reconstructed
 * transforms (ADR 0033 §3): use this only for descendants with no captured stream.
 */
export function reconstructRigidSubtree(
  options: ReconstructRigidSubtreeOptions,
): ReconstructedMesh[] {
  const { proxy, rootPath, rootWorld, rootWorldAtScan } = options;
  const prefix = `${rootPath}/`;

  const scanRoot =
    rootWorldAtScan ?? proxy.meshes.find((m) => m.path === rootPath && m.world)?.world;
  if (!scanRoot) return [];

  const scanRootInv = invert(transformMat4(scanRoot));
  if (!scanRootInv) return [];

  // M = rootWorld(t) · rootWorld(t0)⁻¹ — the rigid delta applied to every child.
  const delta = multiply(transformMat4(rootWorld), scanRootInv);

  const out: ReconstructedMesh[] = [];
  for (const mesh of proxy.meshes) {
    if (!mesh.path || !mesh.world) continue;
    if (!mesh.path.startsWith(prefix)) continue; // strict descendants only
    const childWorld = multiply(delta, transformMat4(mesh.world));
    out.push({ name: mesh.name, path: mesh.path, world: decompose(childWorld) });
  }
  return out;
}
