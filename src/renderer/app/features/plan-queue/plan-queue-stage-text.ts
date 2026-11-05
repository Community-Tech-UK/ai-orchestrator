/**
 * Words for the Plan Queue steps that have no session: Harness running a job's checks, landing it, or the job
 * waiting for one of those. Shared by the session list and the Plan Queue page so both say the same thing.
 */
import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import { describeHealthDuration } from '../../../../shared/utils/plan-queue-health-lines';
import { foldDetail, planQueueDocumentLabel } from './plan-queue-item-display';

/** A step past this is called out as longer than usual. Checks and landings normally take well under it. */
export const PLAN_QUEUE_STAGE_LONG_MS = 30 * 60_000;

/** How often a shown step time moves on; after the first minute the times count in minutes. */
export const PLAN_QUEUE_STAGE_TICK_MS = 30_000;

export type PlanQueueStageGroup = 'checking' | 'landing' | 'waiting';

export interface PlanQueueStageLine {
  readonly itemId: string;
  /** Which count the job adds to in a run's summary. */
  readonly group: PlanQueueStageGroup;
  /** "Checking desk-crm: tests running, 12 min". */
  readonly text: string;
  /** What the step is, for the tooltip. */
  readonly hint: string;
  readonly long: boolean;
}

const LONG_HINT = ' This is taking longer than usual.';

/** `now` is the caller's clock, so a list re-renders the times together. Null when the job is not in such a step. */
export function planQueueStageLine(item: PlanQueueItemDto, now: number): PlanQueueStageLine | null {
  const stage = item.stage;
  if (!stage) return null;
  const name = planQueueDocumentLabel(item.documentPath);
  // A start slightly ahead of this clock is negative here, which reads as just started.
  const elapsed = stage.startedAt === null ? null : now - stage.startedAt;
  const long = elapsed !== null && elapsed > PLAN_QUEUE_STAGE_LONG_MS;
  const time = elapsed === null ? ''
    : `, ${elapsed < 60_000 ? 'just started' : describeHealthDuration(elapsed)}${long ? ' (longer than usual)' : ''}`;
  const line = (group: PlanQueueStageGroup, text: string, hint: string): PlanQueueStageLine =>
    ({ itemId: item.id, group, text: text + time, hint: long ? hint + LONG_HINT : hint, long });
  switch (stage.name) {
    case 'checks':
      return line('checking', `Checking ${name}: tests running`,
        'Harness is running this job\'s checks itself, so no session shows it.');
    case 'landing':
      return line('landing', `Landing ${name}: commit checks running`,
        'Harness is adding this job to the base branch and running the commit checks, so no session shows it.');
    case 'waiting-for-checks':
      // The queue's own note says why when it is not simply a full slot (paused checks, usage, a closed checker).
      return line('waiting', `${name}: waiting for a free check slot`,
        foldDetail(item.detail)?.preview ?? 'The work is done and waits for Harness to check it.');
    case 'waiting-to-land':
      return line('waiting', `${name}: waiting for another job to finish landing`,
        'Jobs land one at a time; this one has passed its checks.');
  }
}

/** "Plan Queue: 2 checking, 1 landing, 1 waiting", naming any that are taking longer than usual. */
export function planQueueStageSummary(lines: readonly PlanQueueStageLine[]): string {
  const count = (group: PlanQueueStageGroup) => lines.filter(line => line.group === group).length;
  const parts = (['checking', 'landing', 'waiting'] as const)
    .map(group => [count(group), group] as const)
    .filter(([n]) => n > 0)
    .map(([n, group]) => `${n} ${group}`);
  const long = lines.filter(line => line.long).length;
  if (long) parts.push(`${long} taking longer than usual`);
  return `Plan Queue: ${parts.join(', ')}`;
}
