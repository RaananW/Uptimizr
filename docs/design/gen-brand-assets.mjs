// Derives the secondary brand marks from logo.svg:
//   logo-transparent.svg  - the full-colour mark without the app-icon plate
//   logo-mono.svg         - a single-colour (currentColor) flat silhouette
//                           (cube hexagon, with the U groove + 3 cube seams
//                            knocked out via fill-rule evenodd) for stamps,
//                            favicons, watermarks and etching.
//
//   node gen-brand-assets.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- transparent mark: logo.svg minus the plate -----------------------------
const logo = readFileSync(join(HERE, "logo.svg"), "utf8");
const transparent = logo
  .replace(/\s*<!--[^>]*App-icon plate[\s\S]*?-->\s*/i, "\n\n  ")
  .replace(/\s*<rect[^>]*fill="#161210"[^>]*\/>\s*/i, "\n  ");
writeFileSync(join(HERE, "logo-transparent.svg"), transparent);

// --- mono silhouette --------------------------------------------------------
// Cube silhouette hexagon + the U-band opening + the three interior seams.
const HEX = "M128 40 L202 82 L202 170 L128 212 L54 170 L54 82 Z";
// U-band surface outline (must match logo.svg rimPath).
const RIM =
  "M83.6 98.8 L83.6 151.3 L128.0 176.5 L172.4 151.3 L172.4 98.8 " +
  "L157.6 107.2 L157.6 142.7 L128.0 159.5 L98.4 142.7 L98.4 107.2 Z";

// Three interior cube edges meeting at the front-top vertex, as thin quads.
const C = [128, 124];
const seams = [
  [C, [54, 82]],
  [C, [202, 82]],
  [C, [128, 212]],
];
const W = 3.2; // seam width in 256-space
function quad([p, q]) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  const nx = (-dy / len) * (W / 2), ny = (dx / len) * (W / 2);
  const f = (n) => n.toFixed(2);
  return `M${f(p[0] + nx)} ${f(p[1] + ny)} L${f(q[0] + nx)} ${f(q[1] + ny)} L${f(q[0] - nx)} ${f(q[1] - ny)} L${f(p[0] - nx)} ${f(p[1] - ny)} Z`;
}
const seamPaths = seams.map(quad).join(" ");

const mono = `<svg width="256" height="256" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Uptimizr">
  <!-- Single-colour mark. Set color via the SVG element's color / currentColor. -->
  <path fill-rule="evenodd" fill="currentColor"
    d="${HEX} ${RIM} ${seamPaths}"/>
</svg>
`;
writeFileSync(join(HERE, "logo-mono.svg"), mono);

console.log("wrote logo-transparent.svg + logo-mono.svg");
