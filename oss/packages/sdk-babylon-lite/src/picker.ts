import type { Mesh, SceneContext } from "@babylonjs/lite";
// Runtime imports: Babylon Lite's GPU picker is the only way to resolve a
// pointer to a world-space hit + named mesh (Lite surfaces no synchronous
// raycaster). `@babylonjs/lite` is an (optional) peer dependency the host page
// provides; esbuild keeps it external — it is never bundled.
import { createGpuPicker, disposePicker, pickAsync } from "@babylonjs/lite";

/** A resolved GPU pick: the world-space hit point (Lite's left-handed frame) and mesh name. */
export interface LitePickHit {
  /** World-space hit point `[x, y, z]` in Lite's native (left-handed) frame. */
  point: [number, number, number] | undefined;
  /** Name of the picked mesh, when it has one. */
  mesh: string | undefined;
}

/**
 * A pluggable async picking probe. The default implementation wraps Lite's
 * `createGpuPicker` / `pickAsync` / `disposePicker`; tests inject a stub so
 * picking is exercised without a real WebGPU device.
 */
export interface LitePickProbe {
  /**
   * Resolve a hit at the given **pixel** coordinates on the canvas. Resolves to
   * `undefined` when nothing was hit.
   */
  pick(pixelX: number, pixelY: number): Promise<LitePickHit | undefined>;
  /** Release the underlying GPU picker. */
  dispose(): void;
}

/**
 * Build the default GPU picking probe for a Lite scene. The picker is created
 * lazily on first use so a connector that captures no pointer channels never
 * allocates one.
 */
export function createScenePicker(scene: SceneContext): LitePickProbe {
  let picker: ReturnType<typeof createGpuPicker> | undefined;
  let disposed = false;
  // A GPU picker owns a single readback buffer; issuing a second `pickAsync`
  // while a prior `mapAsync` is still pending throws "Buffer already has an
  // outstanding map pending". The pointer path and the gaze probe (ADR 0030)
  // share one picker, so picks can overlap. Serialize them through a promise
  // chain so only one readback is ever in flight — each call still resolves with
  // its own coordinates.
  let tail: Promise<unknown> = Promise.resolve();

  return {
    pick(pixelX: number, pixelY: number): Promise<LitePickHit | undefined> {
      if (disposed) return Promise.resolve(undefined);
      const run = async (): Promise<LitePickHit | undefined> => {
        if (disposed) return undefined;
        picker ??= createGpuPicker(scene);
        const info = await pickAsync(picker, pixelX, pixelY);
        if (disposed || !info.hit) return undefined;
        const pickedPoint = info.pickedPoint;
        const pickedMesh = info.pickedMesh as Mesh | null;
        return {
          point: pickedPoint ? [pickedPoint[0], pickedPoint[1], pickedPoint[2]] : undefined,
          mesh: pickedMesh?.name ? pickedMesh.name : undefined,
        };
      };
      const result = tail.then(run, run);
      // Keep the chain alive after a rejection without surfacing an unhandled one.
      tail = result.catch(() => undefined);
      return result;
    },
    dispose(): void {
      disposed = true;
      if (picker) {
        disposePicker(picker);
        picker = undefined;
      }
    },
  };
}
