// Pointer-lock "click to play" overlay for the walkable demos.
//
// Walkable scenes engage pointer lock on a click. If that click landed on the
// tracked canvas it would be recorded as an in-scene `pointer_click` — but it's
// really a UI gesture to enter the control mode, not a pick. We solve this
// cleanly by capturing the lock-engaging click on a full-viewport overlay that
// sits *above* the canvas while unlocked and steps aside (display:none) once the
// lock is granted. Because the click never reaches the canvas, the analytics
// connector never records it (ADR 0034). Subsequent in-scene clicks (now under
// lock) hit the canvas normally and are captured as expected.

/**
 * The largest pointer movement, in CSS px, one `mousemove` can plausibly carry
 * under Pointer Lock. A fast flick at a low frame rate reaches a hundred or two.
 */
export const MAX_LOCKED_MOVE_PX = 300;

/**
 * Whether a locked `mousemove` is a spike rather than a hand movement. Chrome
 * sometimes reports one huge `movementX`/`movementY` under Pointer Lock (around
 * a button press, after the lock engages), which the look controls turn into a
 * camera swing: a click's press then picks the wall in front and its release,
 * a millisecond later, picks the sky.
 */
export function isLockedMoveSpike(e: { movementX: number; movementY: number }): boolean {
  return Math.abs(e.movementX) > MAX_LOCKED_MOVE_PX || Math.abs(e.movementY) > MAX_LOCKED_MOVE_PX;
}

export interface LockOverlay {
  dispose(): void;
}

/**
 * Mount a "click to explore" overlay that engages pointer lock for a walkable
 * scene without the engaging click reaching (and being recorded on) the canvas.
 *
 * @param canvas  The tracked canvas (used to anchor the overlay in the DOM).
 *                Note: three.js locks the canvas itself, while PlayCanvas locks
 *                `document.body` — so we detect lock engine-agnostically below.
 * @param engage  Engine-specific call that requests pointer lock (e.g.
 *                `controls.lock()` / `app.mouse.enablePointerLock()`).
 */
export function mountLockOverlay(canvas: HTMLElement, engage: () => void): LockOverlay {
  const overlay = document.createElement("div");
  overlay.className = "lock-overlay";
  overlay.setAttribute("role", "button");
  overlay.setAttribute("tabindex", "0");
  overlay.innerHTML =
    '<div class="lock-overlay__card">' +
    '<span class="lock-overlay__title">Click to explore</span>' +
    '<span class="lock-overlay__hint">WASD / arrows to move · mouse to look · Esc to release</span>' +
    "</div>";

  (canvas.parentElement ?? document.body).appendChild(overlay);

  const onEngage = (event: Event): void => {
    // Keep the click off the canvas so it isn't recorded as a pick.
    event.preventDefault();
    event.stopPropagation();
    engage();
  };
  overlay.addEventListener("click", onEngage);

  const onLockChange = (): void => {
    // Any active pointer lock means we're in walk mode: three.js locks the
    // canvas, PlayCanvas locks document.body. The overlay is the only thing
    // that engages lock for this scene, so a non-null lock element is enough.
    const locked = document.pointerLockElement != null;
    overlay.classList.toggle("lock-overlay--hidden", locked);
  };
  document.addEventListener("pointerlockchange", onLockChange);
  onLockChange();

  // Drop movement spikes before any engine's look controls see them (a window
  // capture listener runs ahead of the document and canvas listeners they use).
  const onMove = (e: MouseEvent): void => {
    if (document.pointerLockElement != null && isLockedMoveSpike(e)) e.stopImmediatePropagation();
  };
  window.addEventListener("mousemove", onMove, { capture: true });

  return {
    dispose(): void {
      overlay.removeEventListener("click", onEngage);
      document.removeEventListener("pointerlockchange", onLockChange);
      window.removeEventListener("mousemove", onMove, { capture: true });
      overlay.remove();
    },
  };
}
