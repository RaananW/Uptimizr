// Builds the social-sharing assets for the in-browser demo (demo.uptimizr.com):
//
//   - oss/apps/demo/public/og.png            1200x630 @2x  (Open Graph / Twitter)
//   - oss/apps/demo/public/apple-touch-icon.png  180x180   (iOS home screen)
//   - oss/apps/demo/public/icon-192.png          192x192   (PWA manifest)
//   - oss/apps/demo/public/icon-512.png          512x512   (PWA manifest)
//
// The OG card mirrors the marketing card (gen-og.mjs) but swaps the eyebrow and
// footer copy for demo context ("live, in your browser"). All copy is OUTLINED to
// vector paths with fontkit so the card renders identically without the fonts
// installed at raster time. The brand cube mark is embedded top-right from
// logo.svg (minus the app-icon plate). The PNG icons are rasterised straight from
// the demo's favicon.svg (with the app-icon plate kept).
//
//   node gen-og-demo.mjs
//
// Requires devDependencies: fontkit, sharp, wawoff2 (and the @fontsource* fonts
// that ship with @uptimizr/web).

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import * as fontkit from "fontkit";
import { decompress } from "wawoff2";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DEMO_PUBLIC = join(ROOT, "oss", "apps", "demo", "public");
const OUT = join(DEMO_PUBLIC, "og.png");

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

// --- brand mark: the demo's own azure cube (favicon.svg minus the icon plate) -
const logoInner = readFileSync(join(DEMO_PUBLIC, "favicon.svg"), "utf8")
  .replace(/^[\s\S]*?<svg[^>]*>/, "") // drop the opening <svg ...>
  .replace(/<\/svg>\s*$/, "") // drop the closing </svg>
  .replace(/\s*<!--[^>]*App-icon plate[\s\S]*?-->\s*/i, "\n  ") // drop plate comment
  .replace(/\s*<rect[^>]*rx="56"[^>]*\/>\s*/i, "\n  ") // drop the rounded plate rect
  .trim();

// --- palette (demo app brand: cool near-black + azure→gold ramp) -------------
const INK = "#0b0d12"; // demo app background (--bg)
const TEXT_HI = "#E8EAF0"; // primary text on dark (--ink)
const MUTED = "#9AA3B2"; // captions / eyebrow (--muted)

// --- canvas ------------------------------------------------------------------
const W = 1200;
const H = 630;
const SCALE = 2; // 2x retina -> 2400x1260
const MX = 84; // left margin

// --- copy (demo context) -----------------------------------------------------
const eyebrow = textPath(jb, "LIVE DEMO · RUNS IN YOUR BROWSER", 29, { tracking: 2 });
const h1 = textPath(sg700, "Analytics for", 132);
const h2 = textPath(sg700, "3D scenes.", 132);
const foot = textPath(jb, "interactive · no backend · nothing leaves your browser", 29, {
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
      <stop offset="0%" stop-color="#1D4ED8" stop-opacity="0.55"/>
      <stop offset="45%" stop-color="#15306E" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="${INK}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="18%" cy="118%" r="58%">
      <stop offset="0%" stop-color="#F4C84B" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${INK}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="hot" x1="0" y1="0" x2="1" y2="0.15">
      <stop offset="0%" stop-color="#3B82F6"/>
      <stop offset="42%" stop-color="#60A5FA"/>
      <stop offset="78%" stop-color="#F8D260"/>
      <stop offset="100%" stop-color="#F4C84B"/>
    </linearGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#3B82F6" stop-opacity="0.32"/>
      <stop offset="55%" stop-color="#3B82F6" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#3B82F6" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="${INK}"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#glow2)"/>

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

// --- PWA / Apple icons: rasterise the demo favicon (plate kept) ---------------
const favSvg = readFileSync(join(DEMO_PUBLIC, "favicon.svg"));
for (const [name, size] of [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
]) {
  const dest = join(DEMO_PUBLIC, name);
  await sharp(favSvg, { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(dest);
  console.log(
    `wrote ${dest.replace(ROOT + "/", "")}  (${size}x${size}, ${(statSync(dest).size / 1024).toFixed(1)} KB)`,
  );
}
