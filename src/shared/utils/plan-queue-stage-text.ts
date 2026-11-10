/**
 * Words for the Plan Queue steps that have no session: Harness running a job's checks, landing it, or the job
 * waiting for one of those. Shared by the session list, the Plan Queue page and `plan_queue_status` evidence so all
 * three say the same thing.
 */
import type { PlanQueueCheckWait, PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import { describeHealthDuration } from './plan-queue-health-lines';
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

const CHECK_WAITS: Record<PlanQueueCheckWait, { text: string; hint: string }> = {
  'other-checks': { text: 'waiting for a free check slot', hint: 'Another job\'s checks are using the place this one needs.' },
  'computer-busy': { text: 'waiting for the computer to be less busy', hint: 'Harness holds new checks while the computer is under heavy load.' },
  'harness-held': { text: 'waiting for Harness to start new work again', hint: 'New work is held or paused across Harness, so these checks have not started.' },
  'run-on-hold': { text: 'waiting while this run is on hold', hint: 'Nothing new starts in this run for now. The run shows why.' },
  'tidying-up': { text: 'waiting while Harness tidies up a finished job', hint: 'Nothing new starts in this run until a finished job\'s session and folder are cleared away.' },
  'trying-later': { text: 'waiting to try again', hint: 'Its checks could not start last time, so Harness will try again shortly.' },
  'checked-together': { text: 'waiting to be checked with another job', hint: 'It will be checked as part of another job\'s group.' },
  'no-free-folder': { text: 'waiting for a free work folder', hint: 'Plan Queue jobs are using as many work folders as the "Worktrees in use at once" setting allows. Its checks start when one frees up.' },
};
const CHECK_WAIT_UNKNOWN = { text: 'waiting for its turn to be checked', hint: 'The work is done and waits for Harness to check it.' };

/** `now` is the caller's clock, so a list re-renders the times together. Null when the job is not in such a step. */
export function planQueueStageLine(item: PlanQueueItemDto, now: number): PlanQueueStageLine | null {
  const stage = item.stage;
  if (!stage) return null;
  const name = planQueueDocumentLabel(item.sourceRef);
  // A start slightly ahead of this clock is negative here, which reads as just started.
  const elapsed = stage.startedAt === null ? null : now - stage.startedAt;
  // A landing can wait a day for edits; that isn't a step running long.
  const long = stage.name !== 'waiting-for-edits' && elapsed !== null && elapsed > PLAN_QUEUE_STAGE_LONG_MS;
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
    case 'waiting-for-checks': {
      const wait = stage.checkWait ? CHECK_WAITS[stage.checkWait] : CHECK_WAIT_UNKNOWN;
      // The queue's own note is more exact when it has one (usage, a closed checker), but a held job's note only says
      // it was paused, which is no longer why it waits.
      const note = stage.checkWait === 'no-free-folder' ? undefined : foldDetail(item.detail)?.preview;
      return line('waiting', `${name}: ${wait.text}`, note ?? wait.hint);
    }
    case 'waiting-for-edits':
      return line('waiting', `${name}: passed, waiting for uncommitted edits in the main folder`,
        foldDetail(item.detail)?.preview ?? 'It lands by itself once they are committed or put away.');
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
