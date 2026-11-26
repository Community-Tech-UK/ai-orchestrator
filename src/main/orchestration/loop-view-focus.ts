/**
 * Which loop run the operator is looking at right now (plan 4a change 3).
 *
 * The pause notice is suppressed only while the window is focused *on that
 * loop* — not while some unrelated view is on screen. The renderer owns that
 * knowledge: `app-loop-control` reports the loop its HUD shows (and reports
 * null when the HUD is not on screen), through `LOOP_VIEW_FOCUS`. Main keeps
 * the last report here so `loop-pause-notification` can compare it with the
 * pausing run, and so a notice deferred while the loop was on screen can be
 * delivered once the operator leaves it.
 *
 * Deliberately a plain module: no Electron import (the window's focused state
 * is read separately by the notifier), no IPC wiring (the handler in
 * `loop-handlers.ts` calls `setLoopViewFocus`), so this loads in workers and
 * tests unchanged.
 */

let viewedLoopRunId: string | null = null;

/** Record the loop the focused window is showing; `null` = no loop on screen. */
export function setLoopViewFocus(loopRunId: string | null): void {
  viewedLoopRunId = loopRunId;
}

export function getLoopViewFocus(): string | null {
  return viewedLoopRunId;
}

export function _resetLoopViewFocusForTesting(): void {
  viewedLoopRunId = null;
}
