/**
 * One message per usage-limit event, not one from the adapter and another from the limit handler.
 *
 * A Claude `rate_limit_event` is heard twice, in the same turn of the event loop: the adapter
 * emits it as telemetry (which the usage-overage stop turns into a park or an account switch),
 * and then writes the user's note. The stop cannot reach the adapter and the adapter cannot see
 * the stop, so they meet here. While the adapter delivers the telemetry it opens a window; if
 * the stop does something about the limit it reports what it did, and the adapter's one note
 * then says both. A report outside a window (a message held before sending, a second park for
 * a window the adapter already announced) is refused, and the reporter writes its own note.
 *
 * The turn-error path opens the same kind of window around its call into the limit handler, so
 * the note it writes says what the handler really did (kept waiting for the reset, or held until
 * the user resumes) instead of guessing.
 */

import type { UsageLimitHandling } from './usage-limit-notice';

interface OpenDispatch {
  provider: string;
  /** False when the adapter has already announced this window, so nobody may hand off to it. */
  announce: boolean;
  handling?: UsageLimitHandling;
}

let open: OpenDispatch | null = null;

function inWindow<T>(provider: string, announce: boolean, run: () => T): { result: T; handling?: UsageLimitHandling } {
  const dispatch: OpenDispatch = { provider, announce };
  const outer = open;
  open = dispatch;
  try {
    const result = run();
    return { result, ...(dispatch.handling ? { handling: dispatch.handling } : {}) };
  } finally {
    open = outer;
  }
}

/** Delivers one rate-limit event and returns what, if anything, the listeners reported doing about it. */
export function dispatchRateLimitTelemetry(provider: string, announce: boolean, deliver: () => void): UsageLimitHandling | undefined {
  return inWindow(provider, announce, deliver).handling;
}

/** Runs a step that may act on a limit and returns its result with whatever it reported doing, for the caller who writes the one note. */
export function collectUsageLimitHandling<T>(provider: string, run: () => T): { result: T; handling?: UsageLimitHandling } {
  return inWindow(provider, true, run);
}

/**
 * Called by whatever acted on the limit. True means the adapter that is delivering this event
 * will say it in its one note, so the caller must stay quiet; false means write your own.
 */
export function reportUsageLimitHandling(provider: string, handling: UsageLimitHandling): boolean {
  if (!open || !open.announce || open.provider !== provider) return false;
  if (!open.handling) open.handling = handling;
  return true;
}
