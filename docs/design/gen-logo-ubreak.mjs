// Cube (from logo.svg) with a symmetrical U plotted across the two lower faces,
// wrapping the front vertical edge, rendered as an inset "break" (groove) in the cube.

// --- cube geometry, identical to logo.svg ---
// Front-top-centre vertex (where the two lower faces meet at the top of the front edge).
const O = [128, 124];
const R = [74, -42];   // right-face horizontal axis (front edge -> right-top), a in [0,1]
const Lx = [-74, -42]; // left-face  horizontal axis (front edge -> left-top),  a in [0,1]
const D = [0, 88];     // down the front edge, t in [0,1]

// Map an unfolded-strip coord (s in [-1,1], t in [0,1]) onto the cube's two lower faces.
// s = 0 is the front edge; s>0 lives on the right face, s<0 on the (mirrored) left face.
function MU(s, t) {
  const a = Math.abs(s);
  const ax = s >= 0 ? R : Lx;
  return [O[0] + ax[0] * a + D[0] * t, O[1] + ax[1] * a + D[1] * t];
}

// --- U-shaped hole, built directly in face coordinates (s, t) so its edges run
// parallel to the cube edges and it reads as cut INTO the faces. ---
//   centreline:  8 -> 15 -> 10 -> 16 -> 9
//   = left arm s=-0.5 (top edge t=0 down to face centre t=0.5),
//     across the front edge (s=0) at t=0.5, right arm s=+0.5 back up to t=0.
const ARM = 0.5;                 // arm position = centre of each face
const BASE = 0.5;                // base level = face centre / front-edge centre
// thickness = 20% of edge 2->4 (one face width). s-axis ~ 85px, t-axis = 88px.
const HS = 0.10;                 // half-thickness along s (0.20 total = 20%)
const HT = (0.20 * Math.hypot(74, 42) / 2) / 88; // same px thickness expressed in t

const toPath = (arr, close) => "M" + arr.map((p, i) => (i ? "L" : "") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ") + (close ? " Z" : "");
const mapST = (pts, off = [0, 0]) => toPath(pts.map(([s, t]) => { const p = MU(s, t); return [p[0] + off[0], p[1] + off[1]]; }), true);

// Full U outline (outer loop down/around, inner loop back), front-edge (s=0) vertices
// inserted so the base folds correctly over the front vertical edge.
const outline = [
  [-(ARM + HS), 0],           // left arm, outer top
  [-(ARM + HS), BASE + HT],   // left arm, outer bottom
  [0,           BASE + HT],   // front edge, outer
  [ (ARM + HS), BASE + HT],   // right arm, outer bottom
  [ (ARM + HS), 0],           // right arm, outer top
  [ (ARM - HS), 0],           // right arm, inner top
  [ (ARM - HS), BASE - HT],   // right arm, inner bottom
  [0,           BASE - HT],   // front edge, inner
  [-(ARM - HS), BASE - HT],   // left arm, inner bottom
  [-(ARM - HS), 0],           // left arm, inner top
];
// Per-face halves (split at the front edge s=0) for face-correct shading.
const leftHalf = [
  [-(ARM + HS), 0], [-(ARM + HS), BASE + HT], [0, BASE + HT],
  [0, BASE - HT], [-(ARM - HS), BASE - HT], [-(ARM - HS), 0],
];
const rightHalf = [
  [0, BASE + HT], [ (ARM + HS), BASE + HT], [ (ARM + HS), 0],
  [ (ARM - HS), 0], [ (ARM - HS), BASE - HT], [0, BASE - HT],
];

const rimPath = mapST(outline);
const floorLeft = mapST(leftHalf);
const floorRight = mapST(rightHalf);

// --- shallow depth shown on the TOP face: the cut emerges at the top edge (points 8/9)
// and goes a little way toward the centre 17 -- only 10% of the 8->17 distance. ---
// Top-face mapping: point = 4 + Lx*u + R*v  (u along 4->2, v along 4->3); 17 = (0.5,0.5).
const MT = (u, v) => [O[0] + Lx[0] * u + R[0] * v, O[1] + Lx[1] * u + R[1] * v];
const mapUV = (pts) => toPath(pts.map(([u, v]) => MT(u, v)), true);
const DEP = 0.10; // cut depth as a fraction of the 8->17 span (0.5 face units)
// Left arm emerges along edge 4->2 (u = arm position, v = depth into the top face).
const topDepthLeft = mapUV([
  [ARM - HS, 0], [ARM + HS, 0], [ARM + HS, DEP], [ARM - HS, DEP],
]);
// Right arm emerges along edge 4->3 (v = arm position, u = depth into the top face).
const topDepthRight = mapUV([
  [0, ARM - HS], [0, ARM + HS], [DEP, ARM + HS], [DEP, ARM - HS],
]);

// --- 3D model of the cut, for correct flat shading of each new face ---
// Cube axes as 3D unit directions and their screen projections (origin = vertex 4).
//   X = into-cube-from-LEFT-face (screen R), Y = into-cube-from-RIGHT-face (screen Lx),
//   Z = down the front edge (screen D).  A surface point sits at depth 0; the cut floor
//   sits at depth DEP along X (left face) or Y (right face).
const proj = ([x, y, z]) => [O[0] + x * R[0] + y * Lx[0] + z * D[0], O[1] + x * R[1] + y * Lx[1] + z * D[1]];
const surf3 = ([s, t]) => (s < 0 ? [0, -s, t] : s > 0 ? [s, 0, t] : [0, 0, t]);
const flr3 = ([s, t]) => (s < 0 ? [DEP, -s, t] : s > 0 ? [s, DEP, t] : [DEP, DEP, t]);
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const LIGHT = norm3([-0.55, -0.35, -0.9]); // key light from up-front-left
const VIEW = norm3([-1, -1, -0.955]);      // toward the viewer (iso)
const litK = (N) => 0.30 + 0.82 * Math.max(0, dot3(N, LIGHT)); // ambient + diffuse

const num = (p) => p.map((n) => n.toFixed(1)).join(" ");
const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
const hex = (rgb) => "#" + rgb.map((c) => clamp(c).toString(16).padStart(2, "0")).join("");
const shade = (base, k) => hex(base.map((c) => c * k));
const topBase = [243, 196, 80];   // cube top hue
const leftBase = [228, 142, 62];  // cube left hue
const rightBase = [194, 66, 50];  // cube right hue

// Floor faces (parallel to their parent face, recessed -> extra occlusion factor).
const polyST = (pts, m) => "M" + pts.map((st, i) => (i ? "L" : "") + num(proj(m(st)))).join(" ") + " Z";
const floorLeftFace = polyST(leftHalf, flr3);
const floorRightFace = polyST(rightHalf, flr3);
const floorLeftFill = shade(leftBase, litK([-1, 0, 0]) * 0.7);
const floorRightFill = shade(rightBase, litK([0, -1, 0]) * 0.7);

// Wall faces: one quad per U-outline edge, surface rim -> floor. Flat-shaded by 3D normal.
const E = outline.length;
const walls = [];
for (let i = 0; i < E; i++) {
  const a = outline[i], b = outline[(i + 1) % E];
  const Sa = surf3(a), Sb = surf3(b), Fa = flr3(a), Fb = flr3(b);
  let N = norm3(cross3(sub3(Sb, Sa), sub3(Fa, Sa)));
  if (dot3(N, VIEW) < 0) N = [-N[0], -N[1], -N[2]]; // face the viewer
  // Edge lying on the top edge (both t=0) is the groove's OPENING on the top face: you look
  // down into the cut, so it reads as the dark recessed floor, not a bright top-facing lip.
  const isLip = a[1] === 0 && b[1] === 0;
  const midS = (a[0] + b[0]) / 2;
  const fill = isLip
    ? (midS < 0 ? floorLeftFill : floorRightFill)
    : shade(midS < 0 ? leftBase : rightBase, litK(N));
  const quad = [Sa, Sb, Fb, Fa].map(proj);
  const cen = [Sa, Sb, Fa, Fb].reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4], [0, 0, 0]);
  walls.push({ d: "M" + quad.map((p, j) => (j ? "L" : "") + num(p)).join(" ") + " Z", fill, depth: dot3(cen, VIEW) });
}
walls.sort((p, q) => p.depth - q.depth); // far first (painter's order)
const wallsSVG = walls.map((w) => `  <path d="${w.d}" fill="${w.fill}"/>`).join("\n");


const svg = `<svg width="256" height="256" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Uptimizr logo">
  <defs>
    <linearGradient id="uz-top" x1="54" y1="40" x2="202" y2="124" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#F7CE57"/><stop offset="1" stop-color="#EDAE42"/>
    </linearGradient>
    <linearGradient id="uz-left" x1="54" y1="82" x2="128" y2="212" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#EC9B3D"/><stop offset="1" stop-color="#D9633A"/>
    </linearGradient>
    <linearGradient id="uz-right" x1="128" y1="124" x2="202" y2="212" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#D4513A"/><stop offset="1" stop-color="#A82E26"/>
    </linearGradient>
    <!-- Occlusion = the groove's PORTAL: the U-band opening on the front faces plus the two
         top-face openings where the cut emerges. The solid wedge between the openings (near
         vertex 4) is excluded, hiding the small triangle that projects up behind it. -->
    <clipPath id="frontfaces">
      <path d="${rimPath}"/>
      <path d="${topDepthLeft}"/>
      <path d="${topDepthRight}"/>
    </clipPath>
  </defs>

  <!-- App-icon plate (omit this rect for a transparent mark). -->
  <rect x="0" y="0" width="256" height="256" rx="56" fill="#161210"/>

  <!-- Isometric cube, faces shaded as a thermal heatmap. -->
  <path d="M128 40 L202 82 L128 124 L54 82 Z" fill="url(#uz-top)"/>
  <path d="M54 82 L128 124 L128 212 L54 170 Z" fill="url(#uz-left)"/>
  <path d="M202 82 L202 170 L128 212 L128 124 Z" fill="url(#uz-right)"/>

  <!-- U-shaped hole, flat-shaded per 3D face: recessed floor + walls (incl. top openings).
       Clipped to the front faces so the centre-joint sliver stays behind the top face. -->
  <g clip-path="url(#frontfaces)">
  <path d="${floorLeftFace}" fill="${floorLeftFill}"/>
  <path d="${floorRightFace}" fill="${floorRightFill}"/>
${wallsSVG}
  </g>
${process.env.POINTS ? pointsOverlay() : ""}
</svg>`;
process.stdout.write(svg);

// Optional numbered-point overlay (run with POINTS=1) so the U's own corners can be
// referenced by number when describing the wireframe lines.
function pointsOverlay() {
  // [screen x, y, label-dx, label-dy]
  const U = {
    1:  [...MU(-(ARM + HS), 0),            -12, -8],
    2:  [...MU(-(ARM + HS), BASE + HT),    -14,  2],
    3:  [...MU(0, BASE + HT),                0, 16],
    4:  [...MU( (ARM + HS), BASE + HT),     14,  2],
    5:  [...MU( (ARM + HS), 0),             12, -8],
    6:  [...MU( (ARM - HS), 0),             12,  8],
    7:  [...MU( (ARM - HS), BASE - HT),     14, -2],
    8:  [...MU(0, BASE - HT),                0, -14],
    9:  [...MU(-(ARM - HS), BASE - HT),    -14, -2],
    10: [...MU(-(ARM - HS), 0),            -12,  8],
    11: [...MT(ARM - HS, DEP),              -8, -12],
    12: [...MT(ARM + HS, DEP),             -16, -10],
    13: [...MT(DEP, ARM - HS),               8, -12],
    14: [...MT(DEP, ARM + HS),              16, -10],
  };
  return Object.entries(U).map(([n, [x, y, dx, dy]]) =>
    `  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="#161210" stroke="#FFE8B0" stroke-width="1.2"/>` +
    `<text x="${(x + dx).toFixed(1)}" y="${(y + dy).toFixed(1)}" font-family="ui-monospace,monospace" font-size="11" font-weight="700" fill="#FFF3DC" text-anchor="middle" dominant-baseline="middle" stroke="#161210" stroke-width="2.4" paint-order="stroke">${n}</text>`
  ).join("\n");
}
