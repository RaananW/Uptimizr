// Cool (blue → gold) variant of the Uptimizr brand mark, used as the favicon for
// the in-browser demo (demo.uptimizr.com) and the developer playground.
//
// It is the SAME isometric cube + U-groove geometry as the primary logo
// (gen-logo-ubreak.mjs) — the brand guidelines forbid recolouring faces ad hoc,
// so we reuse the generator's exact 3D construction and only swap the heat ramp:
// the espresso/ember (red → gold) ramp becomes an azure → saffron (blue → gold)
// ramp. Regenerate with:
//
//   cd docs/design
//   node gen-favicon-cool.mjs > ../../examples/playground/public/favicon.svg
//   cp ../../examples/playground/public/favicon.svg ../../oss/apps/demo/public/favicon.svg
//
// The output is a 256×256 app-icon (rounded plate); SVG scales down cleanly to a
// 16px favicon.

// --- cube geometry, identical to logo.svg / gen-logo-ubreak.mjs ---
const O = [128, 124];
const R = [74, -42];
const Lx = [-74, -42];
const D = [0, 88];

function MU(s, t) {
  const a = Math.abs(s);
  const ax = s >= 0 ? R : Lx;
  return [O[0] + ax[0] * a + D[0] * t, O[1] + ax[1] * a + D[1] * t];
}

const ARM = 0.5;
const BASE = 0.5;
const HS = 0.1;
const HT = (0.2 * Math.hypot(74, 42) / 2) / 88;

const toPath = (arr, close) => "M" + arr.map((p, i) => (i ? "L" : "") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ") + (close ? " Z" : "");
const mapST = (pts, off = [0, 0]) => toPath(pts.map(([s, t]) => { const p = MU(s, t); return [p[0] + off[0], p[1] + off[1]]; }), true);

const outline = [
  [-(ARM + HS), 0],
  [-(ARM + HS), BASE + HT],
  [0, BASE + HT],
  [(ARM + HS), BASE + HT],
  [(ARM + HS), 0],
  [(ARM - HS), 0],
  [(ARM - HS), BASE - HT],
  [0, BASE - HT],
  [-(ARM - HS), BASE - HT],
  [-(ARM - HS), 0],
];
const leftHalf = [
  [-(ARM + HS), 0], [-(ARM + HS), BASE + HT], [0, BASE + HT],
  [0, BASE - HT], [-(ARM - HS), BASE - HT], [-(ARM - HS), 0],
];
const rightHalf = [
  [0, BASE + HT], [(ARM + HS), BASE + HT], [(ARM + HS), 0],
  [(ARM - HS), 0], [(ARM - HS), BASE - HT], [0, BASE - HT],
];

const rimPath = mapST(outline);

const MT = (u, v) => [O[0] + Lx[0] * u + R[0] * v, O[1] + Lx[1] * u + R[1] * v];
const mapUV = (pts) => toPath(pts.map(([u, v]) => MT(u, v)), true);
const DEP = 0.1;
const topDepthLeft = mapUV([
  [ARM - HS, 0], [ARM + HS, 0], [ARM + HS, DEP], [ARM - HS, DEP],
]);
const topDepthRight = mapUV([
  [0, ARM - HS], [0, ARM + HS], [DEP, ARM + HS], [DEP, ARM - HS],
]);

const proj = ([x, y, z]) => [O[0] + x * R[0] + y * Lx[0] + z * D[0], O[1] + x * R[1] + y * Lx[1] + z * D[1]];
const surf3 = ([s, t]) => (s < 0 ? [0, -s, t] : s > 0 ? [s, 0, t] : [0, 0, t]);
const flr3 = ([s, t]) => (s < 0 ? [DEP, -s, t] : s > 0 ? [s, DEP, t] : [DEP, DEP, t]);
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const LIGHT = norm3([-0.55, -0.35, -0.9]);
const VIEW = norm3([-1, -1, -0.955]);
const litK = (N) => 0.3 + 0.82 * Math.max(0, dot3(N, LIGHT));

const num = (p) => p.map((n) => n.toFixed(1)).join(" ");
const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
const hex = (rgb) => "#" + rgb.map((c) => clamp(c).toString(16).padStart(2, "0")).join("");
const shade = (base, k) => hex(base.map((c) => c * k));

// --- the ONLY change from the primary mark: an azure → saffron ramp. ---
// Top = hottest (saffron/gold), cooling down the left to azure, right to deep blue —
// the mirror of the ember ramp, in cool tones. These match the demo/playground UI
// palette (primary azure #3b82f6, accent gold #f4c84b).
const topBase = [244, 200, 75];   // gold  (#f4c84b) — hottest face
const leftBase = [96, 165, 250];  // azure (#60a5fa)
const rightBase = [37, 99, 235];  // deep blue (#2563eb) — coolest face

const polyST = (pts, m) => "M" + pts.map((st, i) => (i ? "L" : "") + num(proj(m(st)))).join(" ") + " Z";
const floorLeftFace = polyST(leftHalf, flr3);
const floorRightFace = polyST(rightHalf, flr3);
const floorLeftFill = shade(leftBase, litK([-1, 0, 0]) * 0.7);
const floorRightFill = shade(rightBase, litK([0, -1, 0]) * 0.7);

const E = outline.length;
const walls = [];
for (let i = 0; i < E; i++) {
  const a = outline[i], b = outline[(i + 1) % E];
  const Sa = surf3(a), Sb = surf3(b), Fa = flr3(a), Fb = flr3(b);
  let N = norm3(cross3(sub3(Sb, Sa), sub3(Fa, Sa)));
  if (dot3(N, VIEW) < 0) N = [-N[0], -N[1], -N[2]];
  const isLip = a[1] === 0 && b[1] === 0;
  const midS = (a[0] + b[0]) / 2;
  const fill = isLip
    ? (midS < 0 ? floorLeftFill : floorRightFill)
    : shade(midS < 0 ? leftBase : rightBase, litK(N));
  const quad = [Sa, Sb, Fb, Fa].map(proj);
  const cen = [Sa, Sb, Fa, Fb].reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4], [0, 0, 0]);
  walls.push({ d: "M" + quad.map((p, j) => (j ? "L" : "") + num(p)).join(" ") + " Z", fill, depth: dot3(cen, VIEW) });
}
walls.sort((p, q) => p.depth - q.depth);
const wallsSVG = walls.map((w) => `  <path d="${w.d}" fill="${w.fill}"/>`).join("\n");

const svg = `<svg width="256" height="256" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Uptimizr">
  <defs>
    <linearGradient id="uz-top" x1="54" y1="40" x2="202" y2="124" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#F8D260"/><stop offset="1" stop-color="#F4C84B"/>
    </linearGradient>
    <linearGradient id="uz-left" x1="54" y1="82" x2="128" y2="212" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7DB4FB"/><stop offset="1" stop-color="#3B82F6"/>
    </linearGradient>
    <linearGradient id="uz-right" x1="128" y1="124" x2="202" y2="212" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2F6FE6"/><stop offset="1" stop-color="#1D4ED8"/>
    </linearGradient>
    <clipPath id="frontfaces">
      <path d="${rimPath}"/>
      <path d="${topDepthLeft}"/>
      <path d="${topDepthRight}"/>
    </clipPath>
  </defs>

  <!-- App-icon plate (omit this rect for a transparent mark). -->
  <rect x="0" y="0" width="256" height="256" rx="56" fill="#0b0d12"/>

  <!-- Isometric cube, faces shaded as a cool (azure → gold) heatmap. -->
  <path d="M128 40 L202 82 L128 124 L54 82 Z" fill="url(#uz-top)"/>
  <path d="M54 82 L128 124 L128 212 L54 170 Z" fill="url(#uz-left)"/>
  <path d="M202 82 L202 170 L128 212 L128 124 Z" fill="url(#uz-right)"/>

  <!-- U-shaped recess, flat-shaded per 3D face: floor + walls (incl. top openings). -->
  <g clip-path="url(#frontfaces)">
  <path d="${floorLeftFace}" fill="${floorLeftFill}"/>
  <path d="${floorRightFace}" fill="${floorRightFill}"/>
${wallsSVG}
  </g>
</svg>`;
process.stdout.write(svg + "\n");
