/**
 * Equirectangular gaze-heat texture builder for `@uptimizr/heatmap` (design
 * §7.6, the polished follow-up to the marker dome in {@link "./gaze"}).
 *
 * Where {@link "./gaze".buildGazeInstances} drops discrete markers on a dome,
 * this turns the same camera-direction bins (`azimuth_bin`, `elevation_bin`,
 * `count` from `GET /api/v1/heatmaps/camera`) into a **continuous** equirectangular
 * heat texture. Mapped onto an inward-facing skydome centered on the live camera,
 * the developer can stand inside a smooth field of where visitors looked — which
 * reads especially naturally in WebXR.
 *
 * This module is engine-free: it returns raw RGBA pixels that any engine can
 * upload (the Babylon helper `showGazeSkydome` wraps it in a `DynamicTexture`).
 * It is the texture counterpart of the Tier 0 overlay (ADR 0010).
 */
import { clamp01, defaultColorRamp } from "./colorRamp.js";
import type { GazeData } from "./gaze.js";
import type { ColorRamp } from "./types.js";

/** Knobs controlling how gaze bins are splatted into an equirectangular texture. */
export interface GazeEquirectOptions {
  /**
   * Texture width in texels (azimuth axis, wraps). Default `256`. Height is
   * derived as `width / 2` unless {@link height} is given, keeping the standard
   * 2:1 equirectangular aspect.
   */
  width?: number;
  /** Texture height in texels (elevation axis). Default `width / 2`. */
  height?: number;
  /** Intensity → RGB ramp. Defaults to {@link "./colorRamp".defaultColorRamp}. */
  colorRamp?: ColorRamp;
  /**
   * Gaussian splat radius, expressed in bin widths. Each populated bin is spread
   * over neighbouring texels with an angular standard deviation of
   * `blurBins * (π / gridSize)` radians, so the field reads as a smooth heat
   * cloud rather than hard cells. Default `1.5`.
   */
  blurBins?: number;
  /**
   * Per-texel alpha at zero intensity, in `[0, 1]`. `0` (default) makes empty sky
   * fully transparent so the host scene shows through; raise it for a tinted dome.
   */
  alphaFloor?: number;
  /** Peak alpha at full intensity, in `[0, 1]`. Default `1`. */
  opacity?: number;
}

/** An RGBA texture: `rgba` is row-major, top-left origin, length `width * height * 4`. */
export interface GazeEquirectTexture {
  width: number;
  height: number;
  /** Row-major RGBA bytes (`0..255`). Row `0` is the zenith (elevation `+π/2`). */
  rgba: Uint8ClampedArray;
}

const DEFAULTS = {
  width: 256,
  blurBins: 1.5,
  alphaFloor: 0,
  opacity: 1,
} as const;

/** Reconstruct a bin index's continuous spherical angle (azimuth, elevation). */
function binToAngles(
  azimuthBin: number,
  elevationBin: number,
  gridSize: number,
): readonly [az: number, el: number] {
  const az = ((azimuthBin + 0.5) / gridSize) * Math.PI * 2 - Math.PI;
  const el = ((elevationBin + 0.5) / gridSize) * Math.PI - Math.PI / 2;
  return [az, el];
}

/** Unit direction for a spherical angle, matching {@link "./gaze".buildGazeInstances}. */
function angleToDir(az: number, el: number): readonly [number, number, number] {
  const ce = Math.cos(el);
  return [ce * Math.cos(az), Math.sin(el), ce * Math.sin(az)];
}

/**
 * Build an equirectangular gaze-heat texture from camera-direction bins.
 *
 * Each populated bin is splatted with an angular Gaussian (true great-circle
 * distance, so it stays round even near the poles) into a scalar intensity field,
 * which is then normalized so the busiest direction maps to `t = 1` and colored
 * through {@link GazeEquirectOptions.colorRamp}. Pure and engine-free — exported
 * for testing and for hosts that upload the pixels themselves.
 *
 * Texel layout: column `x` is azimuth `((x + 0.5) / width) * 2π - π` (wraps); row
 * `y` is elevation `π/2 - ((y + 0.5) / height) * π`, i.e. row `0` is the zenith.
 */
export function buildGazeEquirect(
  data: GazeData,
  options: GazeEquirectOptions = {},
): GazeEquirectTexture {
  const width = options.width !== undefined && options.width > 0 ? Math.floor(options.width) : DEFAULTS.width;
  const height =
    options.height !== undefined && options.height > 0
      ? Math.floor(options.height)
      : Math.max(1, Math.floor(width / 2));
  const colorRamp = options.colorRamp ?? defaultColorRamp;
  const blurBins = options.blurBins !== undefined && options.blurBins > 0 ? options.blurBins : DEFAULTS.blurBins;
  const alphaFloor = clamp01(options.alphaFloor ?? DEFAULTS.alphaFloor);
  const opacity = clamp01(options.opacity ?? DEFAULTS.opacity);
  const gridSize = data.gridSize > 0 ? data.gridSize : 1;

  const rgba = new Uint8ClampedArray(width * height * 4);

  const bins = data.bins.filter((b) => b.count > 0);
  if (bins.length === 0) return { width, height, rgba };

  // Angular standard deviation (radians) and a 3σ early-out threshold.
  const sigma = Math.max(1e-4, blurBins * (Math.PI / gridSize));
  const twoSigmaSq = 2 * sigma * sigma;
  const cutoff = Math.cos(Math.min(Math.PI, 3 * sigma));

  // Precompute each bin's unit direction once.
  const dirs = bins.map((b) => {
    const [az, el] = binToAngles(b.azimuthBin, b.elevationBin, gridSize);
    return angleToDir(az, el);
  });

  // Accumulate a scalar intensity field, then normalize.
  const field = new Float32Array(width * height);
  let maxField = 0;
  for (let y = 0; y < height; y++) {
    const el = Math.PI / 2 - ((y + 0.5) / height) * Math.PI;
    const ce = Math.cos(el);
    const ty = Math.sin(el);
    for (let x = 0; x < width; x++) {
      const az = ((x + 0.5) / width) * Math.PI * 2 - Math.PI;
      const tx = ce * Math.cos(az);
      const tz = ce * Math.sin(az);
      let acc = 0;
      for (let i = 0; i < bins.length; i++) {
        const d = dirs[i]!;
        const dot = tx * d[0] + ty * d[1] + tz * d[2];
        if (dot < cutoff) continue; // outside ~3σ → negligible weight
        const ang = Math.acos(dot > 1 ? 1 : dot < -1 ? -1 : dot);
        acc += bins[i]!.count * Math.exp(-(ang * ang) / twoSigmaSq);
      }
      const idx = y * width + x;
      field[idx] = acc;
      if (acc > maxField) maxField = acc;
    }
  }

  if (maxField <= 0) return { width, height, rgba };

  for (let i = 0; i < field.length; i++) {
    const t = clamp01(field[i]! / maxField);
    const [r, g, b] = colorRamp(t);
    const a = (alphaFloor + (1 - alphaFloor) * t) * opacity;
    const o = i * 4;
    rgba[o] = Math.round(r * 255);
    rgba[o + 1] = Math.round(g * 255);
    rgba[o + 2] = Math.round(b * 255);
    rgba[o + 3] = Math.round(clamp01(a) * 255);
  }

  return { width, height, rgba };
}
