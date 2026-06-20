// The exact heat ramp the dashboard 3D panels use (oss/packages/react/src/heat.ts,
// re-exported as `heatRgb` from @uptimizr/react). Replicated here because the
// marketing site does not depend on @uptimizr/react — keeping the values in sync
// means the hero's colors match the real dashboard pixel-for-pixel.
//
// Brand Ember ramp: rust (low) → ember (mid) → saffron (hot).

/** Map a normalized intensity [0,1] to a float RGB heat-ramp (rust → ember → saffron). */
export function heatRgb(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  const rust = [0.698, 0.184, 0.149];
  const ember = [0.878, 0.482, 0.224];
  const saffron = [0.957, 0.784, 0.294];
  const lerp = (a: number[], b: number[], k: number): [number, number, number] => [
    a[0]! + (b[0]! - a[0]!) * k,
    a[1]! + (b[1]! - a[1]!) * k,
    a[2]! + (b[2]! - a[2]!) * k,
  ];
  return x < 0.5 ? lerp(rust, ember, x / 0.5) : lerp(ember, saffron, (x - 0.5) / 0.5);
}
