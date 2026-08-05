/**
 * Frame scheduling for transcript scroll-restore steps.
 *
 * `requestAnimationFrame` does **not fire at all** while the document is
 * hidden — verified live against a running app on 2026-08-01
 * (`document.visibilityState === 'hidden'`, `rafFires: false`). Scoped
 * deliberately to `hidden`: that is what was measured. Occlusion of a
 * still-"visible" window is a different condition and was not tested.
 *
 * That matters because the restore paths in `output-stream.component.ts` raise
 * `isRestoringRef` synchronously and lower it only inside the frame callback,
 * while `OutputScrollService`'s listener short-circuits on that guard
 * (`output-scroll.service.ts:52`). A restore begun while hidden therefore left
 * the guard stuck `true` and scroll tracking dead for that session, silently.
 *
 * Reachable in ordinary use: open an instance, then switch to another app
 * before the frame lands. It is also why driving the transcript over CDP looked
 * like "the scroll listener was never attached" — the 2026-07-25 audit's
 * conclusion, which was only half the story.
 */

/** How long to wait for a frame before running the step anyway. */
export const RESTORE_FRAME_FALLBACK_MS = 250;

/**
 * Run `step` on the next animation frame, or after a short timeout if no frame
 * arrives. Runs exactly once either way.
 *
 * Frame-aligned when the window is visible (which is what the restore wants, to
 * avoid a visible jump); guaranteed to run when it is not.
 */
export function runRestoreFrame(
  step: () => void,
  fallbackMs = RESTORE_FRAME_FALLBACK_MS,
): void {
  let done = false;
  let frameId = 0;
  const once = (): void => {
    if (done) return;
    done = true;
    // Cancel the loser so it does not hold this closure (and the viewport it
    // captures) alive. Mirrors Angular's own `scheduleCallbackWithRafRace`.
    cancelAnimationFrame(frameId);
    clearTimeout(timerId);
    step();
  };
  // Timer first: a synchronously-firing rAF (as in tests, and legal per spec)
  // would otherwise run `once` while `timerId` is still in its temporal dead zone.
  const timerId = setTimeout(once, fallbackMs);
  frameId = requestAnimationFrame(once);
}
