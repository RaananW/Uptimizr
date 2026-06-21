// Builds the social-sharing card (Open Graph / Twitter) -> oss/apps/web/public/og.png
//
// The headline is set in Space Grotesk (variable, instanced to wght 700) and the
// eyebrow/footer in JetBrains Mono. All copy is OUTLINED to vector paths with
// fontkit so the card renders identically without the fonts installed at raster
// time (same approach as the wordmark in gen-lockup.mjs). The brand cube mark is
// embedded top-right from logo.svg (minus the app-icon plate). The font-free SVG
// is rasterised + compressed to a 2x (2400x1260) PNG with sharp.
//
//   node gen-og.mjs
//
// Requires devDependencies: fontkit, sharp (and the @fontsource* fonts that ship
// with @uptimizr/web).

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import * as fontkit from "fontkit";
import { decompress } from "wawoff2";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const OUT = join(ROOT, "oss", "apps", "web", "public", "og.png");

// --- fonts: resolve the @fontsource woff2 shipped with @uptimizr/web ---------
const reqWeb = createRequire(join(ROOT, "oss", "apps", "web", "package.json"));
const sgFile = reqWeb.resolve(
  "@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2",
);
const jbFile = reqWeb.resolve(
  "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
);
// fontkit's variable-font instancing needs a real ttf, so decode woff2 first.
const ttf = async (f) => Buffer.from(await decompress(readFileSync(f)));
const sg = fontkit.create(await ttf(sgFile));
const jb = fontkit.create(await ttf(jbFile));
const sg700 = sg.getVariation({ wght: 700 }); // Space Grotesk Bold

// Lay a string out and outline it to a single SVG path `d` at the given px size,
// with the baseline at y=0 and the first glyph origin at x=0. Returns { d, width }.
function textPath(font, str, size, { tracking = 0 } = {}) {
  const scale = size / font.unitsPerEm;
  const run = font.layout(str);
  let x = 0;
  let d = "";
  for (let i = 0; i < run.glyphs.length; i++) {
    const pos = run.positions[i];
    const gp = run.glyphs[i].path
      .scale(scale, -scale) // flip to SVG's y-down
      .translate(x + pos.xOffset * scale, -pos.yOffset * scale);
    d += gp.toSVG() + " ";
    x += pos.xAdvance * scale + tracking;
  }
  return { d: d.trim(), width: x - tracking };
}

// --- brand mark: logo.svg minus the app-icon plate, ready to embed -----------
const logoInner = readFileSync(join(HERE, "logo.svg"), "utf8")
  .replace(/^[\s\S]*?<svg[^>]*>/, "") // drop the opening <svg ...>
  .replace(/<\/svg>\s*$/, "") // drop the closing </svg>
  .replace(/\s*<!--[^>]*App-icon plate[\s\S]*?-->\s*/i, "\n  ") // drop plate comment
  .replace(/\s*<rect[^>]*fill="#161210"[^>]*\/>\s*/i, "\n  ") // drop plate rect
  .trim();

// --- palette (brand-guidelines §2) ------------------------------------------
const INK = "#161210"; // app background
const TEXT_HI = "#F4EADF"; // primary text on dark
const MUTED = "#A8917C"; // captions / eyebrow

// --- canvas ------------------------------------------------------------------
const W = 1200;
const H = 630;
const SCALE = 2; // 2x retina -> 2400x1260
const MX = 84; // left margin

// --- copy --------------------------------------------------------------------
const eyebrow = textPath(jb, "OPEN-SOURCE · PRIVACY-FIRST · SELF-HOSTABLE", 29, { tracking: 2 });
const h1 = textPath(sg700, "Analytics for", 132);
const h2 = textPath(sg700, "3D scenes.", 132);
const foot = textPath(jb, "heatmaps · mesh interactions · session replay", 29, {
  tracking: 0.5,
});

const yEyebrow = 150;
const yH1 = 330;
const yH2 = 470;
const yFoot = 575;

// --- brand mark placement (top-right, clear of all text) ---------------------
// Cube bbox inside logo.svg's 256 box: x 54..202 (w 148), y 40..212 (h 172).
const LOGO_BB = { x: 54, y: 40, w: 148, h: 172 };
const logoH = 214; // mark height, px
const logoK = logoH / LOGO_BB.h; // 256-space -> px
const logoW = LOGO_BB.w * logoK;
const logoX = W - 60 - logoW; // right margin 60px
const logoY = 60; // top margin
const logoTx = logoX - LOGO_BB.x * logoK;
const logoTy = logoY - LOGO_BB.y * logoK;
const haloCx = logoX + logoW / 2;
const haloCy = logoY + logoH / 2;
const haloR = 175;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="78%" cy="30%" r="62%">
      <stop offset="0%" stop-color="#7a3d1e" stop-opacity="0.55"/>
      <stop offset="45%" stop-color="#3a2113" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="${INK}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="hot" x1="0" y1="0" x2="1" y2="0.15">
      <stop offset="0%" stop-color="#F4C84B"/>
      <stop offset="28%" stop-color="#EDA63E"/>
      <stop offset="62%" stop-color="#E07B39"/>
      <stop offset="100%" stop-color="#C13A2B"/>
    </linearGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#E8853F" stop-opacity="0.30"/>
      <stop offset="55%" stop-color="#E8853F" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#E8853F" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="${INK}"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- brand mark -->
  <circle cx="${haloCx}" cy="${haloCy}" r="${haloR}" fill="url(#halo)"/>
  <g transform="translate(${logoTx.toFixed(3)} ${logoTy.toFixed(3)}) scale(${logoK.toFixed(5)})">${logoInner}</g>

  <!-- eyebrow -->
  <g transform="translate(${MX} ${yEyebrow})"><path d="${eyebrow.d}" fill="${MUTED}"/></g>

  <!-- headline -->
  <g transform="translate(${MX} ${yH1})"><path d="${h1.d}" fill="${TEXT_HI}"/></g>
  <g transform="translate(${MX} ${yH2})"><path d="${h2.d}" fill="url(#hot)"/></g>

  <!-- footer -->
  <g transform="translate(${MX} ${yFoot})"><path d="${foot.d}" fill="${MUTED}"/></g>
</svg>`;

await sharp(Buffer.from(svg))
  .flatten({ background: INK })
  .png({ palette: true, colours: 256, dither: 1, compressionLevel: 9, effort: 10 })
  .toFile(OUT);

console.log(
  `wrote ${OUT.replace(ROOT + "/", "")}  (${W * SCALE}x${H * SCALE}, ${(statSync(OUT).size / 1024).toFixed(1)} KB)`,
);
