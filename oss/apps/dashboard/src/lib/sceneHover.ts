// Shared mesh-hover tooltip wiring for the 3D dashboard panels (issue #123).
//
// Every 3D panel builds its own Babylon scene; this helper gives them one
// consistent hover affordance without per-panel picking boilerplate. A panel
// tags the meshes it wants labelled (set `mesh.metadata.hoverLabel`, or
// `mesh.metadata.hoverLabels[i]` for thin-instanced meshes) and calls
// `attachMeshHover(scene, canvas, setTip)`. On pointer-move the helper picks the
// scene, reads the label off the picked mesh, and reports a canvas-relative tip
// (or `null` to clear). It is rAF-throttled, reuses one closure, and respects
// the orbit/zoom controls (it only reads picks, never consumes the event).

import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";

/** A resolved hover tooltip: the label and the canvas-relative pointer point. */
export interface HoverTip {
  label: string;
  x: number;
  y: number;
}

/** Metadata shape the panels attach to meshes so the helper can label them. */
interface HoverMeta {
  /** Label for a whole mesh (single-mesh nodes, proxy boxes, tubes). */
  hoverLabel?: string;
  /** Per-thin-instance labels, indexed by `pickInfo.thinInstanceIndex`. */
  hoverLabels?: (string | null)[];
}

function labelFor(mesh: AbstractMesh, thinInstanceIndex: number): string | null {
  const meta = mesh.metadata as HoverMeta | null | undefined;
  if (!meta) return null;
  if (thinInstanceIndex >= 0 && meta.hoverLabels) return meta.hoverLabels[thinInstanceIndex] ?? null;
  return meta.hoverLabel ?? null;
}

/**
 * Attach a hover tooltip resolver to a Babylon scene. Returns a disposer that
 * removes the listeners; call it from the render effect's cleanup.
 */
export function attachMeshHover(
  scene: Scene,
  canvas: HTMLCanvasElement,
  onChange: (tip: HoverTip | null) => void,
): () => void {
  let frame = 0;
  let lastLabel: string | null = null;

  const handleMove = (ev: PointerEvent) => {
    const x = ev.offsetX;
    const y = ev.offsetY;
    if (frame) return; // already a pick scheduled this frame
    frame = requestAnimationFrame(() => {
      frame = 0;
      const pick = scene.pick(x, y, (m) => m.isPickable && m.isEnabled());
      const label = pick?.pickedMesh ? labelFor(pick.pickedMesh, pick.thinInstanceIndex ?? -1) : null;
      if (label) {
        onChange({ label, x, y });
      } else if (lastLabel !== null) {
        onChange(null);
      }
      lastLabel = label;
    });
  };

  const clear = () => {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (lastLabel !== null) {
      lastLabel = null;
      onChange(null);
    }
  };

  canvas.addEventListener("pointermove", handleMove);
  canvas.addEventListener("pointerleave", clear);
  return () => {
    canvas.removeEventListener("pointermove", handleMove);
    canvas.removeEventListener("pointerleave", clear);
    if (frame) cancelAnimationFrame(frame);
  };
}
