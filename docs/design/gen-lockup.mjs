// Builds the horizontal "Uptimizr" lockup: the cube mark + the wordmark.
//
// The wordmark is the word "Uptimizr" set in Space Grotesk SemiBold (wght 600)
// and OUTLINED to vector paths (see outline_wordmark / wordmark-spacegrotesk.json)
// so the lockup renders identically everywhere without the font installed.
//
//   node gen-lockup.mjs            -> logo-lockup.svg          (light text, for dark bg)
//                                     logo-lockup-light.svg    (dark text,  for light bg)
//
// Tunables via env: CAP (cap-height px), MARK (mark height px), GAP, PAD.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- mark: reuse logo.svg, minus the app-icon plate -------------------------
const logo = readFileSync(join(HERE, "logo.svg"), "utf8");
const inner = logo
  .replace(/^[\s\S]*?<svg[^>]*>/, "")          // drop opening <svg ...>
  .replace(/<\/svg>\s*$/, "")                  // drop closing </svg>
  .replace(/\s*<!--[^>]*App-icon plate[\s\S]*?-->\s*/i, "\n  ") // drop plate comment
  .replace(/\s*<rect[^>]*fill="#161210"[^>]*\/>\s*/i, "\n  ");  // drop plate rect

// Cube bounding box inside the 256 box (x 54..202, y 40..212) + padding.
const MARK_VB = { x: 46, y: 32, w: 164, h: 188 };

// --- wordmark: outlined Space Grotesk path ----------------------------------
const wm = JSON.parse(readFileSync(join(HERE, "wordmark-spacegrotesk.json"), "utf8"));
const { upem, capHeight, descender, advance } = wm.meta; // font units, y-up

// --- layout -----------------------------------------------------------------
const CAP = Number(process.env.CAP || 60); // wordmark cap height, px
const MARK = Number(process.env.MARK || 92); // mark height, px
const GAP = Number(process.env.GAP || 30); // mark <-> wordmark gap, px
const PAD = Number(process.env.PAD || 14); // canvas padding, px

const s = CAP / capHeight; // font-unit -> px
const k = MARK / MARK_VB.h; // 256-space -> px
const markW = (MARK * MARK_VB.w) / MARK_VB.h;
const wordW = advance * s;
const descPx = Math.abs(descender) * s;

const W = PAD + markW + GAP + wordW + PAD;
const H = PAD + MARK + PAD;

const markY = PAD;
const markCY = markY + MARK / 2;
const baseY = markCY + CAP / 2; // baseline so cap-block is centred on the mark
const wordX = PAD + markW + GAP;

// Flatten the mark via a transformed group (more robust than a nested <svg>):
// translate so the cube bbox origin lands at (PAD, markY), then scale 256-space -> px.
const mtx = PAD - MARK_VB.x * k;
const mty = markY - MARK_VB.y * k;

function lockup(textColor, bg) {
  const rect = bg ? `  <rect width="${W}" height="${H}" fill="${bg}"/>\n` : "";
  return `<svg width="${W.toFixed(1)}" height="${H.toFixed(1)}" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Uptimizr">
${rect}  <!-- mark -->
  <g transform="translate(${mtx.toFixed(3)} ${mty.toFixed(3)}) scale(${k.toFixed(5)})">${inner}</g>
  <!-- wordmark: "Uptimizr", Space Grotesk SemiBold, outlined -->
  <g transform="translate(${wordX.toFixed(2)} ${baseY.toFixed(2)}) scale(${s.toFixed(5)} ${(-s).toFixed(5)})">
    <path d="${wm.d}" fill="${textColor}"/>
  </g>
</svg>
`;
}

writeFileSync(join(HERE, "logo-lockup.svg"), lockup("#F4EADF", null));
writeFileSync(join(HERE, "logo-lockup-light.svg"), lockup("#161210", null));
console.log(`wrote logo-lockup.svg + logo-lockup-light.svg  (${W.toFixed(0)}x${H.toFixed(0)}, upem ${upem}, descPx ${descPx.toFixed(1)})`);
