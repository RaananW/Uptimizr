# Uptimizr — Brand & Design Guidelines

The visual identity for **Uptimizr**, the analytics platform for 3D scenes
("Google Analytics for 3D"). The system is warm, technical, and thermal — a heat
map rendered as a brand.

> Spelling: the **product** is always **Uptimizr** (no second "e").

---

## 1. The mark

The logo is an isometric cube — a stand-in for a 3D scene — shaded as a thermal
heat map (hot top, cooling down the sides). A **U-shaped groove** ("U" for
Uptimizr) is cut into the two lower front faces and is correctly flat-shaded in
3D: you look _down into_ the recess, so its floor and the openings where it
emerges through the top edge read as darker, occluded surfaces.

| Asset                     | File                                           | Use                                                                                  |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| App-icon / primary        | [logo.svg](logo.svg)                           | Default. Includes the rounded espresso plate.                                        |
| Transparent mark          | [logo-transparent.svg](logo-transparent.svg)   | The cube only, no plate — for placing on brand surfaces.                             |
| Monochrome                | [logo-mono.svg](logo-mono.svg)                 | Single-colour silhouette (`currentColor`) for stamps, favicons, watermarks, etching. |
| Horizontal lockup (dark)  | [logo-lockup.svg](logo-lockup.svg)             | Mark + wordmark, light text — for dark backgrounds.                                  |
| Horizontal lockup (light) | [logo-lockup-light.svg](logo-lockup-light.svg) | Mark + wordmark, dark text — for light backgrounds.                                  |

### Construction

The mark is generated, not hand-drawn, so the 3D shading stays consistent. The
generators live alongside the assets:

- [gen-logo-ubreak.mjs](gen-logo-ubreak.mjs) — the cube + U groove (promoted to `logo.svg`).
- [gen-lockup.mjs](gen-lockup.mjs) — the horizontal lockup.
- [gen-brand-assets.mjs](gen-brand-assets.mjs) — the transparent and monochrome marks.
- [gen-og.mjs](gen-og.mjs) — the social-sharing card (`oss/apps/web/public/og.png`).

Regenerate everything with:

```sh
cd docs/design
node gen-logo-ubreak.mjs > logo-ubreak.svg   # optional: refresh the source mark
node gen-lockup.mjs                            # logo-lockup*.svg
node gen-brand-assets.mjs                      # logo-transparent.svg, logo-mono.svg
node gen-og.mjs                                # oss/apps/web/public/og.png
```

The Open Graph card (`gen-og.mjs`) sets the headline in Space Grotesk Bold and
the eyebrow/footer in JetBrains Mono, outlines all copy to vector paths with
`fontkit` (so it renders without the fonts installed), embeds the cube mark
top-right, and rasterises to a 2x (2400x1260) palette PNG with `sharp`. It needs
the `fontkit`, `wawoff2`, and `sharp` devDependencies plus the `@fontsource`
fonts shipped with `@uptimizr/web`.

### Clear space & minimum size

- **Clear space:** keep a margin of at least the cube's _half-width_ (≈ one third
  of the mark's height) clear of other elements on all sides. In the lockups this
  is already built into the padding.
- **Minimum size:** the full-colour mark stays legible down to **24 px**. Below
  that, use [logo-mono.svg](logo-mono.svg) (good to **16 px** favicons).
- **Lockup minimum width:** 120 px. Below this, drop the wordmark and use the
  mark alone.

### Don'ts

- Don't recolour the cube faces individually or break the hot→cool gradient order.
- Don't remove or fill the dark top-face openings of the groove — they are what
  makes the U read as a true 3D recess.
- Don't rotate, skew, add drop shadows/outer glows, or place the mark on a busy
  photographic background.
- Don't substitute a system font for the wordmark (see §3).

---

## 2. Colour — the Ember palette

The palette is a warm espresso base under a saffron→rust **heat ramp**, matching
the heat-map metaphor.

### Surfaces & text (espresso)

| Token        | Hex       | Use                                     |
| ------------ | --------- | --------------------------------------- |
| `ink`        | `#161210` | App background / logo plate.            |
| `panel`      | `#201913` | Cards, panels, raised surfaces.         |
| `edge`       | `#34291F` | Hairline borders, dividers.             |
| `text-hi`    | `#F4EADF` | Primary text on dark, wordmark on dark. |
| `text`       | `#D8C8B8` | Body text on dark.                      |
| `text-muted` | `#A8917C` | Secondary / muted text, captions.       |

### Heat ramp (data + accents)

| Token     | Hex       | Role                                      |
| --------- | --------- | ----------------------------------------- |
| `saffron` | `#F4C84B` | Hottest / highlight, focus rings.         |
| `amber`   | `#EDA63E` | **Primary brand accent.**                 |
| `ember`   | `#E07B39` | **Secondary accent.**                     |
| `coral`   | `#D85438` | Warm mid.                                 |
| `rust`    | `#B22F26` | Coolest of the warm ramp / deep emphasis. |

- **Hero / data gradient:** `amber → coral → rust`.
- **Logo edge gradient (gold rim):** `#FFD15A → #F5B72E → #E0632B`.

### Semantic colours

| State        | Hex       |
| ------------ | --------- |
| Info / focus | `#F4C84B` |
| Warning      | `#EDA63E` |
| Error        | `#D64533` |
| Success      | `#9BB23E` |

### Logo face gradients (reference)

The cube faces use three fixed gradients (see [logo.svg](logo.svg)):

| Face            | Stops               |
| --------------- | ------------------- |
| Top (hottest)   | `#F7CE57 → #EDAE42` |
| Left            | `#EC9B3D → #D9633A` |
| Right (coolest) | `#D4513A → #A82E26` |

The recessed groove faces (floor + walls) are flat-shaded darker variants of the
left/right tones to convey occlusion. These values are computed by the generator
and should not be edited by hand in `logo.svg`.

---

## 3. Typography — the wordmark

The **"Uptimizr" wordmark is set in [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) SemiBold (weight 600)** — a
geometric, slightly technical grotesk whose squared bowls and proportional digits
echo the cube. It is licensed under the **SIL Open Font License 1.1** (free for
commercial use and embedding).

In the lockup SVGs the wordmark is **outlined to vector paths** (no live text), so
the lockup renders identically everywhere without the font installed. The
outlining is reproducible:

- Source glyph data: [wordmark-spacegrotesk.json](wordmark-spacegrotesk.json)
  (Space Grotesk instanced at `wght=600`, `unitsPerEm` 1000, cap height 700).
- The lockup generator embeds that path; re-run `node gen-lockup.mjs` to rebuild.

### Type scale (UI / docs, live text)

Use Space Grotesk for display/headings and a neutral system stack for long-form
body text:

```css
--font-display: "Space Grotesk", system-ui, sans-serif;
--font-body: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
```

| Role                | Font / weight                               |
| ------------------- | ------------------------------------------- |
| Wordmark / logotype | Space Grotesk **SemiBold (600)**            |
| Headings (H1–H3)    | Space Grotesk **Medium–SemiBold (500–600)** |
| Body                | system-ui Regular (400)                     |
| Code / data labels  | monospace                                   |

### Wordmark spec

- **Weight:** 600 (SemiBold). Do not use lighter than 500 or heavier than 700 for
  the logotype.
- **Case:** "Uptimizr" — initial cap, rest lower-case. Never all-caps the logotype.
- **Tracking:** as drawn (0). Do not letter-space the outlined wordmark.
- **Colour:** `text-hi` `#F4EADF` on dark, `ink` `#161210` on light.
- **Mark : cap-height ratio** in the default lockup is ≈ 92 : 60. Keep the
  wordmark cap height optically centred on the mark.

---

## 4. Backgrounds & contrast

- Preferred surface is the espresso `ink` `#161210`; the heat ramp and the
  full-colour mark are tuned for it.
- On light surfaces, use [logo-lockup-light.svg](logo-lockup-light.svg) (dark
  wordmark); the cube itself stays full-colour.
- For single-ink contexts (print, embroidery, favicons), use
  [logo-mono.svg](logo-mono.svg) and set the ink via `color` / `currentColor`.
- Maintain WCAG AA contrast for text: `text-hi`/`text` on `ink`/`panel` pass; the
  heat-ramp colours are accents, not body-text colours on dark.

---

## 5. Files in this folder

`logo*.svg` are the deliverable assets; `gen-*.mjs` are their standalone
generators (plain Node ESM, no dependencies). The `wordmark-eval.svg` sheet and
`logo-ubreak-*` exploration files document how the current design was chosen and
can be ignored for production use.
