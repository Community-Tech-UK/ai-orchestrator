/**
 * Tell the operator when a loop pauses (a no-progress stop, a blocked file, a
 * resource-governor hold, the operator's own Pause).
 *
 * Mirror of `loop-terminal-notification.ts`: the decision of whether and what
 * to notify is pure and testable without Electron, delivery is best-effort,
 * and chatter is throttled to one notice per loop per hour (the plan's rule).
 *
 * Plan 4a change 3: skip the notice only while the window is focused **on that
 * loop** — the paused loop's own HUD is on screen, so the pause is already
 * visible. Focused Settings, another session, another loop's HUD or another
 * app are NOT grounds for suppression: those pauses are not on screen and get
 * their notice. Two signals decide it together: the renderer's reported view
 * (`loop-view-focus`, via `LOOP_VIEW_FOCUS`) and the window's own focus (read
 * here directly, so no window handle is threaded through the coordinator; the
 * reader is a seam for tests).
 *
 * A pause that IS on screen is deferred rather than dropped: the notice is
 * delivered once the operator leaves that loop (view change or window blur),
 * so a suppressed pause can never go unreported forever. Delivery is still
 * subject to the hourly throttle, and a run that is no longer paused by then
 * has been superseded (resumed or ended) and is not re-reported.
 *
 * `NotificationService` owns cooldown, dedupe and quiet hours; this decides
 * only whether a PAUSE is worth reporting at all.
 */

import { getSettingsManager } from '../core/config/settings-manager';
import { getNotificationService } from '../notifications/notification-service';
import { getLoopStoreService } from './loop-store';
import { getLoopViewFocus, setLoopViewFocus } from './loop-view-focus';

export const LOOP_PAUSE_NOTICE_INTERVAL_MS = 60 * 60 * 1000;

const MAX_REASON_CHARS = 140;
const MAX_GOAL_CHARS = 80;

export interface LoopPauseNotice {
  kind: 'loop-paused';
  title: string;
  body: string;
  urgency: 'normal';
}

export interface LoopPauseNoticeInput {
  /** The pausing run, so a focused view can be matched against it. */
  loopRunId: string;
  reason?: string;
  /** The run's goal, used to say WHICH loop paused when several are running. */
  goal?: string;
  notifyEnabled: boolean;
  /** An app window is focused (needed for the on-screen rule). */
  windowFocused: boolean;
  /** The loop the focused window is showing, if any (4a change 3). */
  focusedLoopRunId?: string | null;
  now: number;
  /** When this loop last raised a pause notice, for the hourly throttle. */
  lastNotifiedAt?: number;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Pure: is this pause already on screen in the focused window (4a change 3)? */
export function isPauseNoticeSuppressedByFocus(input: {
  loopRunId: string;
  windowFocused: boolean;
  focusedLoopRunId?: string | null;
}): boolean {
  return input.windowFocused && input.focusedLoopRunId === input.loopRunId;
}

/** Pure: is this pause worth a notice right now? */
export function loopPauseNotice(input: LoopPauseNoticeInput): LoopPauseNotice | null {
  if (!input.notifyEnabled) return null;
  if (isPauseNoticeSuppressedByFocus(input)) return null;
  if (input.lastNotifiedAt !== undefined && input.now - input.lastNotifiedAt < LOOP_PAUSE_NOTICE_INTERVAL_MS) {
    return null;
  }
  const goal = input.goal ? clip(input.goal, MAX_GOAL_CHARS) : '';
  const where = goal ? `“${goal}”` : 'A loop run';
  const reason = input.reason ? clip(input.reason, MAX_REASON_CHARS) : '';
  return {
    kind: 'loop-paused',
    title: 'Loop paused',
    body: reason ? `${where} paused: ${reason}` : `${where} paused.`,
    urgency: 'normal',
  };
}

const lastNotifiedAtByLoop = new Map<string, number>();
// Far beyond normal concurrent loop counts, with a fixed process-memory bound.
const MAX_RETAINED_LOOP_NOTICES = 4096;

interface DeferredPause {
  reason?: string;
  goal?: string;
}
/** Pauses held back only because their loop was on screen, awaiting a flush. */
const deferredByLoop = new Map<string, DeferredPause>();
const MAX_RETAINED_DEFERRED_NOTICES = 256;

type WindowFocusReader = () => boolean;
let windowFocusReader: WindowFocusReader | null = null;

/**
 * Is the operator already in the Harness window? Asked of Electron directly
 * (guarded lazy require, the pattern this repo sanctions) so the coordinator
 * never threads a window handle, and so this module still loads without
 * Electron in tests and worker contexts.
 */
function readWindowFocused(): boolean {
  if (windowFocusReader) return windowFocusReader();
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron');
    return BrowserWindow.getAllWindows().some((w) => w.isFocused());
  } catch {
    return false;
  }
}

function focusedOnThisLoop(loopRunId: string): boolean {
  return isPauseNoticeSuppressedByFocus({
    loopRunId,
    windowFocused: readWindowFocused(),
    focusedLoopRunId: getLoopViewFocus(),
  });
}

function pruneExpiredNotices(now: number): void {
  for (const [loopRunId, notifiedAt] of lastNotifiedAtByLoop) {
    if (now - notifiedAt >= LOOP_PAUSE_NOTICE_INTERVAL_MS) lastNotifiedAtByLoop.delete(loopRunId);
  }
}

/** Deliver one pause notice now, honouring settings and the hourly throttle. */
function deliverLoopPauseNotice(loopRunId: string, reason: string | undefined, goal: string | undefined, now: number): void {
  // Never evict an active throttle to make room: that would permit a second
  // notice inside its hour. At saturation, suppress new notices until expiry.
  if (lastNotifiedAtByLoop.size >= MAX_RETAINED_LOOP_NOTICES) return;
  const notice = loopPauseNotice({
    loopRunId,
    reason,
    goal,
    notifyEnabled: getSettingsManager().get('notifyOnLoopTerminal') !== false,
    windowFocused: readWindowFocused(),
    focusedLoopRunId: getLoopViewFocus(),
    now,
    lastNotifiedAt: lastNotifiedAtByLoop.get(loopRunId),
  });
  if (!notice) return;
  lastNotifiedAtByLoop.set(loopRunId, now);
  getNotificationService().notify({
    kind: notice.kind,
    title: notice.title,
    body: notice.body,
    urgency: notice.urgency,
    fingerprintFields: { loopRunId, cause: 'paused' },
  });
}

/**
 * Fire the notice for a pausing run. Best-effort by construction: everything
 * is inside a catch, because a notification failing must never affect whether
 * a loop pauses. Throttled to one notice per loop per hour. While the window
 * is focused on this loop (plan 4a change 3) the notice is deferred, not
 * dropped: `flushDeferredLoopPauseNotices` delivers it once the operator
 * leaves the loop's view.
 */
export function notifyLoopPaused(loopRunId: string, reason?: string): void {
  try {
    const now = Date.now();
    pruneExpiredNotices(now);
    const goal = goalFor(loopRunId);
    if (focusedOnThisLoop(loopRunId)) {
      // Bounded: evict the least recently deferred entry at saturation, but
      // never for a loop whose entry this call only refreshes.
      if (!deferredByLoop.has(loopRunId) && deferredByLoop.size >= MAX_RETAINED_DEFERRED_NOTICES) {
        const oldest = deferredByLoop.keys().next();
        if (!oldest.done) deferredByLoop.delete(oldest.value);
      }
      deferredByLoop.set(loopRunId, { reason, goal });
      wireWindowBlurFlush();
      return;
    }
    deliverLoopPauseNotice(loopRunId, reason, goal, now);
  } catch {
    // Deliberately swallowed: see above.
  }
}

/**
 * Deliver pause notices that were deferred while their loop was on screen.
 * Called when the view focus changes (`LOOP_VIEW_FOCUS`) and when a window
 * loses focus, so a suppressed pause cannot go unreported once the operator
 * has left it. An entry is kept (not delivered) while its loop is still on
 * screen, and dropped when the run is no longer paused — it was resumed or it
 * ended, and its own event already reported that.
 */
export function flushDeferredLoopPauseNotices(): void {
  try {
    const now = Date.now();
    pruneExpiredNotices(now);
    for (const [loopRunId, entry] of [...deferredByLoop]) {
      if (focusedOnThisLoop(loopRunId)) continue;
      deferredByLoop.delete(loopRunId);
      if (!deferredRunStillPaused(loopRunId)) continue;
      deliverLoopPauseNotice(loopRunId, entry.reason, entry.goal, now);
    }
  } catch {
    // Deliberately swallowed: see above.
  }
}

/**
 * Renderer report of the loop its HUD shows (the `LOOP_VIEW_FOCUS` handler).
 * A change of view is exactly when a deferred notice becomes deliverable.
 */
export function reportLoopViewFocus(loopRunId: string | null): void {
  setLoopViewFocus(loopRunId);
  flushDeferredLoopPauseNotices();
}

function deferredRunStillPaused(loopRunId: string): boolean {
  try {
    const summary = getLoopStoreService().store.getRunSummary(loopRunId);
    return summary ? summary.status === 'paused' : false;
  } catch {
    // Cannot confirm the pause is stale; keep the operator's notice.
    return true;
  }
}

function goalFor(loopRunId: string): string | undefined {
  try {
    return getLoopStoreService().store.getRunSummary(loopRunId)?.initialPrompt;
  } catch {
    return undefined;
  }
}

/**
 * Leaving the Harness window must also flush deferred notices (the operator
 * left the paused loop's screen without an in-app view change). Wired lazily on
 * the first deferral so test and worker contexts without Electron never touch
 * `app`; the listener is idempotent and flush is harmless to repeat.
 */
let windowBlurFlushWired = false;
function wireWindowBlurFlush(): void {
  if (windowBlurFlushWired) return;
  windowBlurFlushWired = true;
  try {
    const { app } = require('electron') as typeof import('electron');
    app.on('browser-window-blur', () => flushDeferredLoopPauseNotices());
  } catch {
    // No Electron: deferrals still flush on the next view-focus report.
  }
}

export function _setLoopPauseWindowFocusReaderForTesting(reader: WindowFocusReader | null): void {
  windowFocusReader = reader;
}

export function _resetLoopPauseNotificationsForTesting(): void {
  lastNotifiedAtByLoop.clear();
  deferredByLoop.clear();
  windowFocusReader = null;
}
