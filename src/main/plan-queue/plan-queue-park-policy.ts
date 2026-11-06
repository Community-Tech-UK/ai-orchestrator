import type { PlanQueueParkReason } from '@contracts/schemas/plan-queue';

/**
 * Park reasons no automatic retry may resume. A job Harness stopped on purpose
 * (a Codex round past its token ceiling, Decision 16a) would spend the same
 * tokens again if a retry restarted it, so only James's explicit Resume does.
 * Phase C's retry rules must ask this before they requeue anything.
 */
const NEVER_AUTO_RETRIED: ReadonlySet<PlanQueueParkReason> = new Set<PlanQueueParkReason>(['stopped-by-harness']);

export function isNeverAutoRetried(reason: PlanQueueParkReason | null): boolean {
  return reason !== null && NEVER_AUTO_RETRIED.has(reason);
}
