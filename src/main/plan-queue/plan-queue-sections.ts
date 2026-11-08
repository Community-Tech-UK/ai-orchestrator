/**
 * A plan too big for one job, with `## Step N` headings, runs as one job per step. The jobs of one document
 * share it inside their run; each waits for the step before it to land, so it branches from the base branch
 * after that landing.
 */
import { readFileSync } from 'node:fs';
import { planSteps } from './plan-queue-plan-extract';
import type { PlanQueueItem } from './plan-queue.types';

/** The plan's steps when it should run as step jobs, or null. An unreadable file is left to the normal path. */
export function stepsToRun(documentPath: string): number[] | null {
  try { return planSteps(readFileSync(documentPath, 'utf8'))?.map(step => step.number) ?? null; }
  catch { return null; }
}

/** What holds a step job back: the step before it in this run. Null when it may start. */
export function stepHold(items: readonly PlanQueueItem[], item: PlanQueueItem): { waitingFor: number; skipped: boolean } | null {
  if (item.section == null) return null;
  const before = items
    .filter(other => other.documentPath === item.documentPath && other.section != null && other.section < item.section!)
    .sort((a, b) => b.section! - a.section!)[0];
  return !before || before.state === 'landed' ? null : { waitingFor: before.section!, skipped: before.state === 'skipped' };
}

/** "Step 2 of 5" for the page: the run's jobs for this document, and the one a queued job is waiting for. */
export function stepLabelFor(items: readonly PlanQueueItem[], item: PlanQueueItem): { number: number; of: number; waitingFor: number | null } | undefined {
  if (item.section == null) return undefined;
  const hold = item.state === 'queued' ? stepHold(items, item) : null;
  return {
    number: item.section,
    of: items.filter(other => other.documentPath === item.documentPath && other.section != null).length,
    waitingFor: hold && !hold.skipped ? hold.waitingFor : null,
  };
}
