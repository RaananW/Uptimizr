import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { trackScene } from "@uptimizr/three";
import type { UptimizrClient } from "@uptimizr/sdk-core";
import type { WebGLRenderer } from "three";

import type { UptimizrOptions } from "./options.js";

/**
 * A stable, mutable reference to the live {@link UptimizrClient} created by
 * {@link useUptimizr}. `current` is `null` until capture starts (and again after it
 * stops / while disabled). Read it to access `sessionId`, emit custom events via
 * `track(...)`, or `stop(...)` early.
 */
export type UptimizrClientRef = { readonly current: UptimizrClient | null };

/**
 * react-three-fiber connector hook. Call it **inside** the `<Canvas>` tree so it can
 * read the live `scene`, `camera`, and `gl` (`WebGLRenderer`) from the R3F store via
 * `useThree()`, then hand them to `@uptimizr/three`'s {@link trackScene}.
 *
 * R3F renders three.js, so the entire capture engine — sampling, raycasting,
 * canonicalization to the wire coordinate frame, batching, transport — is the three
 * connector. This hook is only the idiomatic React glue: it starts capture on mount
 * and **stops it on unmount** (the `useEffect` cleanup calls `client.stop()`), tearing
 * down every listener, timer, and animation-frame callback the three connector
 * registered (ADR 0003: no cookies, no persistent ids).
 *
 * The session is attributed to the R3F connector (`connector.name === "r3f"`) while
 * keeping three's native right-handed coordinate frame; pass `connector` in `options`
 * to override the reported `version` or `name`.
 *
 * ```tsx
 * function Telemetry() {
 *   useUptimizr({ projectId: "your-project", endpoint: "https://collect.example.com" });
 *   return null;
 * }
 *
 * <Canvas>
 *   <Telemetry />
 *   <YourScene />
 * </Canvas>
 * ```
 *
 * Prefer the declarative {@link Uptimizr} component if you don't need the client ref.
 */
export function useUptimizr(options: UptimizrOptions): UptimizrClientRef {
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl);

  const clientRef = useRef<UptimizrClient | null>(null);

  // Keep the latest options reachable from the effect without making them a
  // dependency — re-creating the session on every prop change (sampling dials, etc.)
  // would churn `session_start`/`session_end`. Capture restarts only when the
  // underlying R3F objects (scene/camera/renderer) change identity, or when the
  // `disabled` consent flag flips (below).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // `disabled` IS a dependency so it behaves like the reactive consent flag React
  // users expect (ADR 0003): flipping it `true → false` after the visitor opts in
  // starts capture, and `false → true` tears it down. Reading it from the ref (as
  // the rest of the options are) would freeze it at its mount value.
  const disabled = options.disabled ?? false;

  useEffect(() => {
    if (disabled) return;

    const opts = optionsRef.current;
    const client = trackScene(scene, camera, gl as unknown as WebGLRenderer, {
      ...opts,
      // Attribute the session to the R3F connector while inheriting three's frame.
      connector: { name: "r3f", ...opts.connector },
    });
    clientRef.current = client;

    return () => {
      clientRef.current = null;
      void client.stop("manual");
    };
  }, [scene, camera, gl, disabled]);

  return clientRef;
}
