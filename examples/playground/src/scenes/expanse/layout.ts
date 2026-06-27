// Engine-agnostic layout for the large multi-level "expanse" scene (ADR 0040).
//
// The Babylon build (`./babylon.ts`) leans on the engine's built-in gravity +
// ellipsoid collisions, so it authors its geometry inline. three.js and PlayCanvas
// ship no such walkable physics, so their builds (`./three.ts`, `./playcanvas.ts`)
// share this module: one description of the world (slabs + ramps), one analytic
// height field the first-person controller samples to climb ramps and step onto the
// raised overlook and tower floors, one horizontal-collision list, and — crucially —
// the same section boxes and bounds so all three engines exercise the identical
// large-scene analytics path (bounds-driven cell size, region drill-down,
// coverage/cold-spots, and `setScene` section switching).
//
// World extents and section boxes mirror `./babylon.ts`; keep the two in step.

import { BOX_COLORS, type SceneSection } from "../../engine.js";

/** World half-extents: the ground spans [-HALF_X, HALF_X] × [-HALF_Z, HALF_Z]. */
export const HALF_X = 180;
export const HALF_Z = 280;
export const EYE_HEIGHT = 1.8;
export const WALL_HEIGHT = 8;
/** Raised overlook terrace height (north) — what the entrance ramp climbs to. */
export const OVERLOOK_Y = 12;
/** Per-floor rise of the three-floor tower (floors at y = 0, 6, 12). */
export const FLOOR_RISE = 6;
/** Tower centre on X (east side of the world). */
export const TOWER_CX = 137;

/** Voxel edge (world units) a heatmap overlay would bin with for this large scene. */
export const HEATMAP_CELL_SIZE = 6;

/** First-person spawn: south edge of the plaza, facing north (+Z) up the long axis. */
export const SPAWN = { x: 0, z: -HALF_Z + 20 } as const;

type RGB = readonly [number, number, number];

const COLOR = {
  ground: [0.12, 0.14, 0.2] as RGB,
  wall: [0.2, 0.24, 0.32] as RGB,
  ramp: [0.22, 0.2, 0.16] as RGB,
  overlook: [0.18, 0.2, 0.26] as RGB,
  rail: [0.26, 0.3, 0.4] as RGB,
  tower: [0.2, 0.22, 0.3] as RGB,
  hedge: [0.14, 0.24, 0.16] as RGB,
  pedestal: [0.16, 0.18, 0.24] as RGB,
};

/** One axis-aligned (optionally X-tilted) box to render. Sizes are full extents. */
export interface Slab {
  readonly name: string;
  /** Centre. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Full width/height/depth. */
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  /** Tilt about X in degrees (ramps); 0 for upright boxes. */
  readonly rotXDeg: number;
  readonly color: RGB;
  /** True for the `landmark-N` obelisks the shared pick handler flashes. */
  readonly pickable: boolean;
}

/** Far-apart pickable landmarks; `baseY` lifts the ones on the overlook/tower floors. */
const LANDMARKS: ReadonlyArray<{ index: number; x: number; z: number; baseY: number }> = [
  { index: 0, x: -120, z: -220, baseY: 0 },
  { index: 1, x: 120, z: -220, baseY: 0 },
  { index: 2, x: 0, z: -120, baseY: 0 },
  { index: 3, x: -60, z: -40, baseY: 0 },
  { index: 4, x: -60, z: 250, baseY: OVERLOOK_Y },
  { index: 5, x: 60, z: 250, baseY: OVERLOOK_Y },
  { index: 6, x: TOWER_CX, z: 30, baseY: 0 },
  { index: 7, x: TOWER_CX, z: 30, baseY: FLOOR_RISE },
  { index: 8, x: TOWER_CX, z: 30, baseY: FLOOR_RISE * 2 },
  { index: 9, x: -140, z: 240, baseY: 0 },
];

function rampSlab(
  name: string,
  x: number,
  fromY: number,
  fromZ: number,
  toY: number,
  toZ: number,
  width: number,
): Slab {
  const runZ = toZ - fromZ;
  const rise = toY - fromY;
  const length = Math.hypot(runZ, rise);
  // Tilt so the box's +Z end rises by `rise` over `runZ` (matches Babylon's
  // `rotation.x = -atan2(rise, runZ)`), expressed in degrees for the alt engines.
  const rotXDeg = -(Math.atan2(rise, runZ) * 180) / Math.PI;
  return {
    name,
    x,
    y: (fromY + toY) / 2,
    z: (fromZ + toZ) / 2,
    sx: width,
    sy: 0.6,
    sz: length,
    rotXDeg,
    color: COLOR.ramp,
    pickable: false,
  };
}

function box(
  name: string,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  color: RGB,
): Slab {
  return { name, x, y, z, sx, sy, sz, rotXDeg: 0, color, pickable: false };
}

function buildSlabs(): Slab[] {
  const slabs: Slab[] = [];

  // Perimeter walls so the world is bounded (and the registered AABB well-defined).
  slabs.push(box("wall-n", 0, WALL_HEIGHT / 2, HALF_Z, HALF_X * 2, WALL_HEIGHT, 2, COLOR.wall));
  slabs.push(box("wall-s", 0, WALL_HEIGHT / 2, -HALF_Z, HALF_X * 2, WALL_HEIGHT, 2, COLOR.wall));
  slabs.push(box("wall-e", HALF_X, WALL_HEIGHT / 2, 0, 2, WALL_HEIGHT, HALF_Z * 2, COLOR.wall));
  slabs.push(box("wall-w", -HALF_X, WALL_HEIGHT / 2, 0, 2, WALL_HEIGHT, HALF_Z * 2, COLOR.wall));

  // Plaza structure (south + centre, ground level).
  slabs.push(box("block-1", -90, 5, -120, 30, 10, 30, COLOR.wall));
  slabs.push(box("block-2", 70, 7, -90, 26, 14, 26, COLOR.wall));

  // Ramp up to the raised overlook terrace (north).
  slabs.push(rampSlab("ramp-overlook", 0, 0, 40, OVERLOOK_Y, 140, 20));

  // Overlook terrace (north, elevated) + railings with a gap at the ramp mouth.
  slabs.push(box("overlook-deck", 0, OVERLOOK_Y - 0.5, 210, 160, 1, 140, COLOR.overlook));
  slabs.push(box("rail-n", 0, OVERLOOK_Y + 0.75, 280, 160, 1.5, 1, COLOR.rail));
  slabs.push(box("rail-e", 80, OVERLOOK_Y + 0.75, 210, 1, 1.5, 140, COLOR.rail));
  slabs.push(box("rail-w", -80, OVERLOOK_Y + 0.75, 210, 1, 1.5, 140, COLOR.rail));

  // Tower (east): three open floors joined by internal switchback ramps. Each upper
  // floor is split around an open stairwell (slot above the arriving ramp + a north
  // landing) so the ramp leads all the way onto the floor instead of into a ceiling.
  slabs.push(box("tower-floor-2-w", TOWER_CX - 31, FLOOR_RISE - 0.4, 10, 8, 0.8, 90, COLOR.tower));
  slabs.push(box("tower-floor-2-e", TOWER_CX + 13, FLOOR_RISE - 0.4, 10, 44, 0.8, 90, COLOR.tower));
  slabs.push(box("tower-floor-2-n", TOWER_CX - 18, FLOOR_RISE - 0.4, 47.5, 18, 0.8, 15, COLOR.tower));
  slabs.push(box("tower-floor-3-w", TOWER_CX - 13, FLOOR_RISE * 2 - 0.4, 10, 44, 0.8, 90, COLOR.tower));
  slabs.push(box("tower-floor-3-e", TOWER_CX + 31, FLOOR_RISE * 2 - 0.4, 10, 8, 0.8, 90, COLOR.tower));
  slabs.push(box("tower-floor-3-n", TOWER_CX + 18, FLOOR_RISE * 2 - 0.4, 47.5, 18, 0.8, 15, COLOR.tower));
  for (const [cx, cz] of [
    [TOWER_CX - 32, -33],
    [TOWER_CX + 32, -33],
    [TOWER_CX - 32, 53],
    [TOWER_CX + 32, 53],
  ] as const) {
    slabs.push(
      box(`tower-col-${cx}-${cz}`, cx, FLOOR_RISE, cz, 2, FLOOR_RISE * 2 + 4, 2, COLOR.tower),
    );
  }
  slabs.push(rampSlab("tower-ramp-1", TOWER_CX - 18, 0, -30, FLOOR_RISE, 40, 14));
  // L2 → L3 ramp climbs north (low-z L2 end up to high-z L3 landing), mirroring ramp-1
  // so both ramps top out at their floor's north landing.
  slabs.push(rampSlab("tower-ramp-2", TOWER_CX + 18, FLOOR_RISE, -30, FLOOR_RISE * 2, 40, 14));

  // Gardens (far north-west corner) — intentionally out of the way (a cold spot).
  for (let i = 0; i < 4; i += 1) {
    slabs.push(box(`hedge-${i}`, -150 + (i % 2) * 24, 1, 170 + i * 22, 18, 2, 4, COLOR.hedge));
  }

  // Pickable landmarks: a tall obelisk on a base, placed far apart.
  for (const lm of LANDMARKS) {
    slabs.push(box(`pedestal-${lm.index}`, lm.x, lm.baseY + 0.5, lm.z, 3, 1, 3, COLOR.pedestal));
    const rgb = BOX_COLORS[lm.index % BOX_COLORS.length] ?? ([0.8, 0.8, 0.8] as RGB);
    slabs.push({
      name: `landmark-${lm.index}`,
      x: lm.x,
      y: lm.baseY + 3.5,
      z: lm.z,
      sx: 1.4,
      sy: 5,
      sz: 1.4,
      rotXDeg: 0,
      color: rgb,
      pickable: true,
    });
  }

  return slabs;
}

/** Every box (geometry) the three.js / PlayCanvas builds instantiate. */
export const SLABS: ReadonlyArray<Slab> = buildSlabs();

export const GROUND = { width: HALF_X * 2, depth: HALF_Z * 2, color: COLOR.ground } as const;

/**
 * Highest walkable surface under `(x, z)` the visitor may step to from `currentFloorY`.
 * The world's walkable platforms are described analytically (ground, the entrance ramp,
 * the overlook deck, the two tower floors, and the tower's internal ramps); a small
 * step-up budget lets the visitor climb ramps/onto floors but not teleport up onto a
 * platform from directly underneath (so the tower's open ground floor stays reachable).
 */
export function floorHeightAt(x: number, z: number, currentFloorY: number): number {
  const STEP_UP = 1.6;
  const candidates: number[] = [0]; // ground is everywhere

  // Entrance ramp: 0 → OVERLOOK_Y over z ∈ [40, 140] in the x ∈ [-10, 10] lane.
  if (x >= -10 && x <= 10 && z >= 40 && z <= 140) {
    candidates.push(((z - 40) / 100) * OVERLOOK_Y);
  }
  // Overlook deck top.
  if (x >= -80 && x <= 80 && z >= 140 && z <= 280) {
    candidates.push(OVERLOOK_Y);
  }
  // Tower floors (footprint shared by L2 and L3).
  if (x >= 102 && x <= 172 && z >= -35 && z <= 55) {
    candidates.push(FLOOR_RISE);
    candidates.push(FLOOR_RISE * 2);
  }
  // Tower ramp 1 (ground → L2): climbs north over z ∈ [-30, 40].
  if (x >= 112 && x <= 126 && z >= -30 && z <= 40) {
    candidates.push(((z + 30) / 70) * FLOOR_RISE);
  }
  // Tower ramp 2 (L2 → L3): climbs north over z ∈ [-30, 40], 6 at the south end up
  // to 12 at the north end (mirrors ramp 1).
  if (x >= 148 && x <= 162 && z >= -30 && z <= 40) {
    candidates.push(FLOOR_RISE + ((z + 30) / 70) * FLOOR_RISE);
  }

  let best = 0;
  for (const h of candidates) {
    if (h <= currentFloorY + STEP_UP && h > best) best = h;
  }
  return best;
}

interface SolidAabb {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Solid obstacles the visitor can't walk through (plaza blocks + tower columns). */
const SOLIDS: ReadonlyArray<SolidAabb> = [
  { minX: -105, maxX: -75, minZ: -135, maxZ: -105, minY: 0, maxY: 10 }, // block-1
  { minX: 57, maxX: 83, minZ: -103, maxZ: -77, minY: 0, maxY: 14 }, // block-2
  ...(
    [
      [TOWER_CX - 32, -33],
      [TOWER_CX + 32, -33],
      [TOWER_CX - 32, 53],
      [TOWER_CX + 32, 53],
    ] as const
  ).map(([cx, cz]) => ({
    minX: cx - 1,
    maxX: cx + 1,
    minZ: cz - 1,
    maxZ: cz + 1,
    minY: -2,
    maxY: 14,
  })),
];

const PLAYER_RADIUS = 1.4;

/**
 * Resolve horizontal movement: clamp to the perimeter, then push the visitor out of
 * any solid obstacle whose vertical span overlaps their body. A simple min-penetration
 * push (slide along the nearest face) — enough to keep manual walking honest without a
 * physics engine.
 */
export function resolveWalk(x: number, z: number, footY: number): { x: number; z: number } {
  const bound = HALF_X - PLAYER_RADIUS;
  const boundZ = HALF_Z - PLAYER_RADIUS;
  let nx = Math.max(-bound, Math.min(bound, x));
  let nz = Math.max(-boundZ, Math.min(boundZ, z));
  const headY = footY + EYE_HEIGHT;
  for (const s of SOLIDS) {
    if (headY < s.minY || footY > s.maxY) continue;
    if (
      nx > s.minX - PLAYER_RADIUS &&
      nx < s.maxX + PLAYER_RADIUS &&
      nz > s.minZ - PLAYER_RADIUS &&
      nz < s.maxZ + PLAYER_RADIUS
    ) {
      const dxLeft = nx - (s.minX - PLAYER_RADIUS);
      const dxRight = s.maxX + PLAYER_RADIUS - nx;
      const dzNear = nz - (s.minZ - PLAYER_RADIUS);
      const dzFar = s.maxZ + PLAYER_RADIUS - nz;
      const minPen = Math.min(dxLeft, dxRight, dzNear, dzFar);
      if (minPen === dxLeft) nx = s.minX - PLAYER_RADIUS;
      else if (minPen === dxRight) nx = s.maxX + PLAYER_RADIUS;
      else if (minPen === dzNear) nz = s.minZ - PLAYER_RADIUS;
      else nz = s.maxZ + PLAYER_RADIUS;
    }
  }
  return { x: nx, z: nz };
}

/** Scene id reported while the camera is in none of the {@link SECTIONS}. */
export const DEFAULT_SCENE_ID = "expanse-plaza";

/**
 * Named sub-areas (ADR 0040 §5). Tested in order; the first box containing the camera
 * wins, else the visitor is in the plaza. Tower floors split on Y so each level is its
 * own tracked area. Mirrors `./babylon.ts`.
 */
export const SECTIONS: ReadonlyArray<SceneSection> = [
  { id: "expanse-tower-l3", aabb: [100, 10, -40, 175, 40, 60] },
  { id: "expanse-tower-l2", aabb: [100, 4, -40, 175, 10, 60] },
  { id: "expanse-tower-l1", aabb: [100, -1, -40, 175, 4, 60] },
  { id: "expanse-overlook", aabb: [-80, 10, 140, 80, 40, 280] },
  { id: "expanse-ramp", aabb: [-14, -1, 40, 14, 20, 140] },
  { id: "expanse-gardens", aabb: [-180, -1, 140, -100, 12, 280] },
];
