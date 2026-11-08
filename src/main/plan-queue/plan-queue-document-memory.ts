/** What earlier attempts at a document say about starting it again. Attempts survive Resume and discard, so this reads them all. */
import { statSync } from 'node:fs';
import type { PlanQueueParkReason } from '@contracts/schemas/plan-queue';
import { failureOwner, normaliseFailure } from './plan-queue-failure-class';
import type { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueItem } from './plan-queue.types';

/** Stops that say something about the computer or a provider, whatever their wording. */
const NOT_ABOUT_THE_CODE: ReadonlySet<PlanQueueParkReason> = new Set<PlanQueueParkReason>([
  'triage-failed', 'worktree-error', 'provider-limit', 'check-hung', 'restart-loop', 'stopped-by-harness', 'needs-setup', 'needs-james',
]);

function stoppedTheSameWay(last: PlanQueueItem, before: PlanQueueItem): boolean {
  if (last.state !== 'parked' || before.state !== 'parked' || last.parkReason !== before.parkReason) return false;
  const words = last.detail ?? '';
  if (normaliseFailure(words) !== normaliseFailure(before.detail ?? '')) return false;
  return (last.parkReason !== null && NOT_ABOUT_THE_CODE.has(last.parkReason)) || failureOwner(words) !== 'job';
}

function changedSince(documentPath: string, at: number): boolean {
  try { return statSync(documentPath).mtimeMs > at; } catch { return true; }
}

/**
 * Why a bulk start should leave this document out: its last two attempts stopped for the same reason, one that isn't about
 * its code, and it hasn't changed, so a third would stop there too. Picking the document by name still starts it.
 */
export function repeatedStopNote(store: Pick<PlanQueueStore, 'latestAttempts' | 'lastParkedAt'>, documentPath: string): string | null {
  const [last, before] = store.latestAttempts(documentPath, 2);
  if (!before || !stoppedTheSameWay(last, before) || changedSince(documentPath, store.lastParkedAt(last.id) ?? 0)) return null;
  return `Left out of this run: its last two attempts stopped the same way, and the document hasn't changed. Pick it by name to start it anyway. Last stop: ${(last.detail ?? last.parkReason ?? 'unknown').slice(0, 300)}`;
}
