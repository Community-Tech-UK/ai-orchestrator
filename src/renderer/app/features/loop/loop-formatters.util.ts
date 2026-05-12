/**
 * Pure formatting helpers for Loop Mode UI.
 *
 * Extracted from `LoopControlComponent` so the same labels/durations/
 * timestamps can be reused by sibling components (the past-runs panel,
 * the active-loop strip, future detail views) without duplicating the
 * arithmetic. All functions are pure: same input → same output, no
 * Angular dependencies, trivially unit-testable.
 *
 * Time-relative helpers (`relativeTime`) intentionally don't read a
 * "now" signal themselves — callers re-render on whatever cadence they
 * need (the loop control component runs a 1Hz tick) and pass `now` in
 * if they want to override (mostly for tests).
 */

/** Renders a wall-clock duration in milliseconds as `Ns`, `NmSs`, or
 *  `NhMm`. Used for "loop ran for 9m3s"-style summaries. */
export function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m${Math.floor((ms % 60_000) / 1000)}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m`;
}

/** Renders a token count compactly: `850 tok`, `12.3k tok`, `1.20M tok`. */
export function humanTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${(n / 1_000_000).toFixed(2)}M tok`;
}

/** `HH:MM:SS` (24-hour, zero-padded). Used for the activity feed. */
export function shortTime(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getHours().toString().padStart(2, '0'),
    date.getMinutes().toString().padStart(2, '0'),
    date.getSeconds().toString().padStart(2, '0'),
  ].join(':');
}

/** Activity-feed event-kind label. Falls through to the raw kind for
 *  forward-compat with new event types added later by the coordinator. */
export function activityKindLabel(kind: string): string {
  switch (kind) {
    case 'tool_use': return 'tool';
    case 'input_required': return 'input';
    case 'stream-idle': return 'quiet';
    default: return kind;
  }
}

/**
 * Friendly label for a *terminal* loop status — what we show on the
 * "Loop ended — …" summary card. Confined to the five terminal states
 * by its parameter type so callers don't accidentally render
 * "running ✓" on the summary.
 */
export type TerminalLoopStatus =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'cap-reached'
  | 'error'
  | 'no-progress';

export function terminalStatusLabel(status: TerminalLoopStatus): string {
  switch (status) {
    case 'completed':   return 'completed ✓';
    case 'cancelled':   return 'cancelled';
    case 'failed':      return 'failed';
    case 'cap-reached': return 'cap reached';
    case 'error':       return 'error';
    case 'no-progress': return 'no progress';
  }
}

/**
 * Friendly label for *any* loop status — used for the persisted
 * past-runs list which can include running/paused entries (e.g. when
 * the app was killed mid-run). Returns the raw status verbatim for any
 * unrecognized value so a future LoopStatus addition still renders
 * something rather than a blank cell.
 */
export function loopStatusLabel(status: string): string {
  switch (status) {
    case 'completed':   return 'completed';
    case 'cancelled':   return 'cancelled';
    case 'failed':      return 'failed';
    case 'cap-reached': return 'cap';
    case 'error':       return 'error';
    case 'no-progress': return 'no-progress';
    case 'paused':      return 'paused';
    case 'running':     return 'running';
    default:            return status;
  }
}

/** "5s ago" / "2m ago" / "3h ago" / "4d ago" / "Apr 12". `now` exists for
 *  test seams; production callers omit it and let `Date.now()` win. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  const d = new Date(ts);
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
}

/** Locale-formatted full timestamp (used as a tooltip on relative-time
 *  cells so users can hover to see exactly when something happened). */
export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Cents → `$X.YY`. Trivial helper but keeps `(cost / 100).toFixed(2)`
 *  out of templates, where the implicit number→string coercion is easy
 *  to mis-key. */
export function formatCostCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
