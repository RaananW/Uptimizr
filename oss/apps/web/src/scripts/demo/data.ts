// Emulated-but-consistent analytics data for the hero demo. The numbers are
// synthetic, but the SHAPES are exactly what the dashboard renders: world-space
// voxel bins (WorldHeatmap3D), camera direction bins (CameraDome3D), click rays
// (ClickRays3D), and gaze→mesh flow links (FlowSankey3D). A single small "scene"
// (a few axis-aligned proxy boxes) anchors all four views so they feel coherent.

/** Deterministic PRNG so the demo looks identical on every load. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Axis-aligned bounding box: [minX, minY, minZ, maxX, maxY, maxZ]. */
export type AABB = [number, number, number, number, number, number];
export interface ProxyMesh {
  name: string;
  aabb: AABB;
}
export interface Voxel {
  vx: number;
  vy: number;
  vz: number;
  count: number;
}
export interface DirBin {
  az: number;
  el: number;
  count: number;
}
export interface Ray {
  origin: [number, number, number];
  hit: [number, number, number];
  count: number;
}
export interface FlowLink {
  az: number;
  el: number;
  mesh: string;
  count: number;
}

/** A tiny "kiosk" scene the analytics are attached to (matches dashboard proxy boxes). */
export const PROXY_MESHES: ProxyMesh[] = [
  { name: "Floor", aabb: [-1.2, -0.52, -1.2, 1.2, -0.42, 1.2] },
  { name: "Body", aabb: [-0.5, -0.42, -0.5, 0.5, 0.6, 0.5] },
  { name: "Screen", aabb: [-0.36, 0.6, -0.06, 0.36, 1.12, 0.06] },
  { name: "Panel", aabb: [0.5, -0.12, -0.32, 0.92, 0.5, 0.32] },
];

/** Where attention concentrates: [x, y, z, weight]. */
const HOTSPOTS: [number, number, number, number][] = [
  [0, 0.85, 0.08, 1], // screen
  [0, 0.1, 0.5, 0.8], // body front
  [0.7, 0.2, 0.33, 0.55], // side panel
];

export function meshCenter(aabb: AABB): [number, number, number] {
  return [(aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2];
}

/**
 * Snap a point onto the surface of the nearest proxy mesh so heat voxels sit ON
 * the geometry instead of floating in the air. Points outside a box clamp to it;
 * points inside push out to the closest face.
 */
function snapToMeshSurface(x: number, y: number, z: number): [number, number, number] {
  let best: [number, number, number] = [x, y, z];
  let bestDist = Infinity;
  for (const { aabb } of PROXY_MESHES) {
    const [minX, minY, minZ, maxX, maxY, maxZ] = aabb;
    let sx = Math.min(maxX, Math.max(minX, x));
    let sy = Math.min(maxY, Math.max(minY, y));
    let sz = Math.min(maxZ, Math.max(minZ, z));
    if (sx === x && sy === y && sz === z) {
      // Inside the box — push out along the axis with the nearest face.
      const faces: [number, number, "x" | "y" | "z"][] = [
        [x - minX, minX, "x"],
        [maxX - x, maxX, "x"],
        [y - minY, minY, "y"],
        [maxY - y, maxY, "y"],
        [z - minZ, minZ, "z"],
        [maxZ - z, maxZ, "z"],
      ];
      faces.sort((a, b) => a[0] - b[0]);
      const [, coord, axis] = faces[0]!;
      if (axis === "x") sx = coord;
      else if (axis === "y") sy = coord;
      else sz = coord;
    }
    const d = Math.hypot(sx - x, sy - y, sz - z);
    if (d < bestDist) {
      bestDist = d;
      best = [sx, sy, sz];
    }
  }
  return best;
}

/** World-space pointer-hit density, voxel-binned exactly like WorldHeatmap3D. */
export function makeVoxels(cellSize: number): Voxel[] {
  const rng = mulberry32(7);
  const map = new Map<string, Voxel>();
  for (const [hx, hy, hz, w] of HOTSPOTS) {
    const n = Math.round(60 * w);
    for (let i = 0; i < n; i++) {
      const r = 0.16 + 0.12 * rng();
      const x = hx + (rng() - 0.5) * r * 2;
      const y = hy + (rng() - 0.5) * r * 2;
      const z = hz + (rng() - 0.5) * r * 1.2;
      // Pointer hits land on scene surfaces — snap the sample onto the nearest mesh.
      const [sx, sy, sz] = snapToMeshSurface(x, y, z);
      const vx = Math.round(sx / cellSize);
      const vy = Math.round(sy / cellSize);
      const vz = Math.round(sz / cellSize);
      const key = `${vx},${vy},${vz}`;
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else map.set(key, { vx, vy, vz, count: 1 });
    }
  }
  return [...map.values()];
}

/** Camera look-direction bins on a sphere, exactly like CameraDome3D. */
export function makeDirectionBins(gridSize: number): DirBin[] {
  const rng = mulberry32(11);
  const map = new Map<string, DirBin>();
  // [azFrac, elFrac, weight] — clustered around forward / horizon / a glance up.
  const clusters: [number, number, number][] = [
    [0.5, 0.5, 1],
    [0.43, 0.57, 0.7],
    [0.61, 0.46, 0.6],
    [0.5, 0.64, 0.55],
  ];
  for (const [af, ef, w] of clusters) {
    const n = Math.round(48 * w);
    for (let i = 0; i < n; i++) {
      const az = Math.min(
        gridSize - 1,
        Math.max(0, Math.round((af + (rng() - 0.5) * 0.16) * gridSize)),
      );
      const el = Math.min(
        gridSize - 1,
        Math.max(0, Math.round((ef + (rng() - 0.5) * 0.14) * gridSize)),
      );
      const key = `${az},${el}`;
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else map.set(key, { az, el, count: 1 });
    }
  }
  return [...map.values()];
}

/** Click rays from camera positions to surface hit points, like ClickRays3D. */
export function makeRays(): Ray[] {
  const rng = mulberry32(19);
  const origins: [number, number, number][] = [
    [1.6, 0.8, 1.6],
    [-1.7, 0.6, 1.3],
    [0.2, 1.5, 2.0],
    [1.9, 0.4, -0.6],
  ];
  const targets: [number, number, number][] = [
    [0, 0.85, 0.12],
    [0, 0.1, 0.5],
    [0.7, 0.2, 0.33],
  ];
  const rays: Ray[] = [];
  for (const o of origins) {
    const n = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const t = targets[Math.floor(rng() * targets.length)]!;
      const hit: [number, number, number] = [
        t[0] + (rng() - 0.5) * 0.22,
        t[1] + (rng() - 0.5) * 0.22,
        t[2] + (rng() - 0.5) * 0.18,
      ];
      rays.push({ origin: o, hit, count: 1 + Math.floor(rng() * 9) });
    }
  }
  return rays;
}

/** Gaze-direction → clicked-mesh links, like FlowSankey3D. */
export function makeFlowLinks(gridSize: number): FlowLink[] {
  const rng = mulberry32(23);
  const meshes = ["Screen", "Body", "Panel", "Floor"];
  const sources: [number, number][] = [
    [Math.round(0.5 * gridSize), Math.round(0.52 * gridSize)],
    [Math.round(0.43 * gridSize), Math.round(0.6 * gridSize)],
    [Math.round(0.61 * gridSize), Math.round(0.46 * gridSize)],
    [Math.round(0.5 * gridSize), Math.round(0.64 * gridSize)],
  ];
  const links: FlowLink[] = [];
  for (const [az, el] of sources) {
    for (const mesh of meshes) {
      if (rng() < 0.3) continue;
      links.push({ az, el, mesh, count: 2 + Math.floor(rng() * 30) });
    }
  }
  return links;
}
