/**
 * A plan too big for one job, with `## Step N` headings, runs as one job per step. The jobs of one document
 * share it inside their run; each waits for the step before it to land, so it branches from the base branch
 * after that landing.
 */
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { basename } from 'node:path';
import { planSteps } from './plan-queue-plan-extract';
import type { PlanQueueItem } from './plan-queue.types';

/**
 * The steps of a plan that need a job, or null when the plan has no steps to split by (an unreadable file is left to the
 * normal path). A step whose checklist is fully ticked has landed already and gets none; a step without a checklist
 * always does. An empty list means every step is done.
 */
export function stepsToRun(documentPath: string): number[] | null {
  try { return planSteps(readFileSync(documentPath, 'utf8'))?.filter(step => step.boxes === 0 || step.open > 0).map(step => step.number) ?? null; }
  catch { return null; }
}

/** What holds a step job back: the step before it in this run. Null when it may start. */
export function stepHold(items: readonly PlanQueueItem[], item: PlanQueueItem): { waitingFor: number; skipped: boolean } | null {
  if (item.section == null) return null;
  const before = items
    .filter(other => other.sourceRef === item.sourceRef && other.section != null && other.section < item.section!)
    .sort((a, b) => b.section! - a.section!)[0];
  return !before || before.state === 'landed' ? null : { waitingFor: before.section!, skipped: before.state === 'skipped' };
}

/** The run's last job for a stepped document: the one that writes the plan's as-built summary. */
export function isLastStepJob(items: readonly PlanQueueItem[], item: PlanQueueItem): boolean {
  return item.section != null && !items.some(other => other.sourceRef === item.sourceRef && other.section != null && other.section > item.section!);
}

/** True when this landing finishes the plan: it is the last step job and every job before it has landed. */
export function finishesPlan(items: readonly PlanQueueItem[], item: PlanQueueItem): boolean {
  return isLastStepJob(items, item)
    && items.every(other => other.id === item.id || other.sourceRef !== item.sourceRef || other.section == null || other.state === 'landed');
}

/**
 * Why a step job cannot go on: its plan is gone from its place, or was renamed to the closed name. A step job never
 * closes its plan, and the later steps and the closing session still need it. Null when the plan is as it should be.
 */
export async function stepPlanProblem(documentPath: string): Promise<string | null> {
  const closed = documentPath.replace(/\.md$/i, '_completed.md');
  const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false);
  if (closed !== documentPath && await exists(closed)) {
    return `The plan was renamed to ${basename(closed)}, but a step job never closes its plan. Rename it back to ${basename(documentPath)}, then press Resume.`;
  }
  return await exists(documentPath) ? null : `The plan ${basename(documentPath)} is no longer where this step expects it. Put it back, then press Resume.`;
}

/** The key of `totalRoundsByDocument`: rounds are counted per document, or per step for a plan that runs one job per step. */
export function roundsKey(documentPath: string, section: number | null | undefined): string {
  return `${documentPath}\0${section ?? ''}`;
}

/**
 * What the page says about a step job: the step's own number, which job of the run's jobs for this document it is
 * (steps already ticked off get none, so the two can differ), and the step a queued job is waiting for.
 */
export function stepLabelFor(items: readonly PlanQueueItem[], item: PlanQueueItem): { number: number; position: number; of: number; waitingFor: number | null } | undefined {
  if (item.section == null) return undefined;
  const siblings = items.filter(other => other.sourceRef === item.sourceRef && other.section != null);
  const hold = item.state === 'queued' ? stepHold(items, item) : null;
  return {
    number: item.section,
    position: siblings.filter(other => other.section! <= item.section!).length,
    of: siblings.length,
    waitingFor: hold && !hold.skipped ? hold.waitingFor : null,
  };
}
