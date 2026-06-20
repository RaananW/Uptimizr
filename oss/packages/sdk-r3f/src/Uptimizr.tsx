import { useUptimizr } from "./useUptimizr.js";
import type { UptimizrOptions } from "./options.js";

/**
 * Declarative react-three-fiber connector. Drop it anywhere **inside** a `<Canvas>`
 * and it wires Uptimizr capture for the live scene/camera/renderer, rendering nothing.
 * It's a thin wrapper over {@link useUptimizr} for users who prefer JSX to a hook.
 *
 * ```tsx
 * import { Uptimizr } from "@uptimizr/r3f";
 *
 * <Canvas>
 *   <Uptimizr projectId="your-project" endpoint="https://collect.example.com" />
 *   <YourScene />
 * </Canvas>
 * ```
 *
 * Capture starts when the component mounts and stops when it unmounts. Use the
 * {@link useUptimizr} hook directly if you need the {@link UptimizrClient} reference.
 */
export function Uptimizr(props: UptimizrOptions): null {
  useUptimizr(props);
  return null;
}
