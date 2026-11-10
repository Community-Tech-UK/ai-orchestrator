/**
 * The step an item is in when no session shows it: Harness running its checks, landing it (the merge and commit
 * checks), or waiting for either. Worker and checker sessions are in the session list already; these steps are
 * ordinary programs the queue runs, so without this the list looked empty while a job was busy. Display only.
 */
import type { PlanQueueCheckWait, PlanQueueItemStage } from '@contracts/schemas/plan-queue';
import type { PlanQueueHistoryStore, PlanQueueStageMarks } from './plan-queue-history-store';
import type { PlanQueueSlotWaits } from './plan-queue-timings';
import { isLandingWait } from './plan-queue-state';
import type { PlanQueueItem } from './plan-queue.types';

const latest = (a: number | null, b: number | null): number | null => a === null ? b : b === null ? a : Math.max(a, b);

/**
 * `sessionStartedAt` is when this app session's queue started. Landings run one at a time in memory, so a landing
 * turn recorded before it died with the previous session: until its new turn starts the item is waiting.
 */
export function itemStage(item: PlanQueueItem, marks: PlanQueueStageMarks | undefined, sessionStartedAt: number,
  checkWait?: PlanQueueCheckWait, waitingSince?: number): PlanQueueItemStage | null {
  if (item.heldAt != null) {
    // A held job shows as paused, unless it is ready to resume its checks and only a free work folder is missing.
    // Its time counts from when its checks were first held back after the pause, not from entering awaiting-slot.
    return item.state === 'awaiting-slot' && checkWait === 'no-free-folder'
      ? { name: 'waiting-for-checks', startedAt: waitingSince ?? null, checkWait } : null;
  }
  const enteredAt = marks?.enteredAt ?? null;
  switch (item.state) {
    case 'awaiting-slot':
      return { name: 'waiting-for-checks', startedAt: enteredAt, ...(checkWait ? { checkWait } : {}) };
    case 'verifying':
      return item.verifierInstanceId ? null : { name: 'checks', startedAt: latest(enteredAt, marks?.checksAt ?? null) };
    case 'landing': {
      if (isLandingWait(item)) return { name: 'waiting-for-edits', startedAt: item.landingWaitSince ?? enteredAt };
      const turn = marks?.landingAt ?? null;
      return turn !== null && turn >= sessionStartedAt && (enteredAt === null || turn >= enteredAt)
        ? { name: 'landing', startedAt: turn }
        : { name: 'waiting-to-land', startedAt: enteredAt };
    }
    default:
      return null;
  }
}

const STAGE_STATES: ReadonlySet<PlanQueueItem['state']> = new Set<PlanQueueItem['state']>(['awaiting-slot', 'verifying', 'landing']);

/** Stages for the items that have one, from one history read covering only items in those states. */
export function itemStages(history: Pick<PlanQueueHistoryStore, 'stageMarks'>, items: readonly PlanQueueItem[],
  sessionStartedAt: number, waits?: Pick<PlanQueueSlotWaits, 'whyWaiting' | 'waitingSince'>): Map<string, PlanQueueItemStage> {
  const candidates = items.filter(item => STAGE_STATES.has(item.state));
  const marks = history.stageMarks(candidates.map(item => item.id));
  const stages = new Map<string, PlanQueueItemStage>();
  for (const item of candidates) {
    const stage = itemStage(item, marks.get(item.id), sessionStartedAt, waits?.whyWaiting(item.id), waits?.waitingSince(item.id));
    if (stage) stages.set(item.id, stage);
  }
  return stages;
}
