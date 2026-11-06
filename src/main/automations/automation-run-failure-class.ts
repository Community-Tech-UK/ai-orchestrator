/**
 * A15 / 8a — classify automation run failures so retries only retry what a
 * retry can fix.
 *
 * Seeded from the 30-day failure table (read-only query, 10 Oct 2026):
 *
 * - `never`: a run that can ever succeed is re-attempted for nothing — a
 *   missing wake-up target, a Codex turn that stalled past its notification
 *   window, flagged content, a workspace routing discovery failure. These set
 *   `retryable = false`.
 * - `wait`: a transient environmental refusal that says nothing about the job
 *   itself — the resource governor paused instance creation, or the target
 *   conversation already has an active turn. These keep today's retry
 *   behaviour (the retry costs no tokens when no instance was created) but
 *   record the failure without growing the auto-disable streak, exactly like
 *   provider limits.
 * - `normal`: anything else — today's behaviour, retried and counted.
 */

export type AutomationRunFailureClass = 'never' | 'wait' | 'normal';

const NEVER_PREFIXES: readonly string[] = [
  'Thread wakeup failed: target_missing',
  'Codex turn stalled: no notifications received',
  'This content was flagged for possible cybersecurity risk',
  'workspace routing discovery failed',
];

/** The observed busy-conversation race from a `sendInput` that lost to a turn. */
const BUSY_TURN_MARKER = 'already has an active turn';

export function classifyAutomationRunFailure(
  error: string | null | undefined,
): AutomationRunFailureClass {
  const text = (error ?? '').trim();
  if (!text) {
    return 'normal';
  }
  if (NEVER_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return 'never';
  }
  if (
    text.startsWith('Instance creation is paused by the resource governor')
    || (text.startsWith('Thread wakeup send failed:') && text.includes(BUSY_TURN_MARKER))
  ) {
    return 'wait';
  }
  return 'normal';
}

/**
 * A sendInput race against a turn that started after admission: the write is
 * refused with an "active turn" error instead of being queued. Callers end the
 * run quietly (skipped) rather than failed.
 */
export function isBusyConversationSendError(error: string | null | undefined): boolean {
  return (error ?? '').includes(BUSY_TURN_MARKER);
}
