/**
 * N9 — periodically tell the operator when sessions are sitting blocked on
 * approvals. See `pending-approval-digest.ts` for why one aggregate line rather
 * than one notification per approval.
 */

import { getLogger } from '../logging/logger';
import { getNotificationService } from '../notifications/notification-service';
import { pendingApprovalDigest, type PendingApprovalLike } from './pending-approval-digest';

const logger = getLogger('PendingApprovalWatcher');

/** Approvals are a human-scale wait; polling faster buys nothing. */
export const APPROVAL_POLL_MS = 5 * 60_000;
/** Don't speak up the instant an approval appears — you may be about to answer it. */
export const APPROVAL_MIN_AGE_MS = 5 * 60_000;
/** Once reminded, stay quiet for a while even if the queue persists. */
export const APPROVAL_REMIND_EVERY_MS = 60 * 60_000;

export interface PendingApprovalWatcherOptions {
  listPending: () => PendingApprovalLike[];
  pollMs?: number;
  minAgeMs?: number;
  remindEveryMs?: number;
  now?: () => number;
  onDigest?: (body: string) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
/**
 * `null` means "never notified", NOT 0. With 0 the first check computes
 * `now() - 0`, an absolute timestamp, and compares it to the reminder window —
 * which happens to work with a real epoch clock and silently suppresses the
 * first notification under any smaller clock. A sentinel says what it means.
 */
let lastNotifiedAt: number | null = null;

export function startPendingApprovalWatcher(options: PendingApprovalWatcherOptions): void {
  if (timer) return;
  const now = options.now ?? (() => Date.now());
  const remindEvery = options.remindEveryMs ?? APPROVAL_REMIND_EVERY_MS;
  lastNotifiedAt = null;

  timer = setInterval(() => {
    try {
      const digest = pendingApprovalDigest({
        pending: options.listPending(),
        now: now(),
        minAgeMs: options.minAgeMs ?? APPROVAL_MIN_AGE_MS,
      });
      if (!digest) {
        // Queue cleared: re-arm so the next block is reported promptly rather
        // than swallowed by the previous reminder window.
        lastNotifiedAt = null;
        return;
      }
      if (lastNotifiedAt !== null && now() - lastNotifiedAt < remindEvery) return;
      lastNotifiedAt = now();

      if (options.onDigest) {
        options.onDigest(digest.body);
        return;
      }
      getNotificationService().notify({
        kind: 'pending-approvals',
        title: digest.title,
        body: digest.body,
        urgency: 'normal',
        fingerprintFields: { instances: digest.instances, approvals: digest.approvals },
      });
    } catch (err) {
      logger.debug('Pending approval digest failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, options.pollMs ?? APPROVAL_POLL_MS);
  timer.unref?.();
}

export function stopPendingApprovalWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastNotifiedAt = null;
}

export function _resetForTesting(): void {
  stopPendingApprovalWatcher();
}
