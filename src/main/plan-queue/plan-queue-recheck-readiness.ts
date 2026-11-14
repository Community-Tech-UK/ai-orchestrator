/** Re-investigate an unanswered prerequisite without choosing an option or granting authority. */
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueTriage } from './plan-queue-triage';

export function recheckReadiness(
  host: Pick<PlanQueueFlowHost, 'getItem' | 'getRun' | 'transition'>,
  itemId: string, actor: string,
  guards: { answering: boolean; controllingRun: boolean; triage: Pick<PlanQueueTriage, 'recheckItem'> | null },
): void {
  // No await between checking and saving: answers and run controls cannot interleave.
  if (guards.answering) throw new Error('This document is applying an answer. Wait for it to finish before rechecking.');
  if (guards.controllingRun) throw new Error('This run is applying another control. Wait for it to finish before rechecking.');
  const item = host.getItem(itemId);
  const run = host.getRun(item.runId);
  if (run.status !== 'running' && run.status !== 'paused') throw new Error('Readiness can only be rechecked in a running or paused run.');
  if (item.state !== 'needs-answer' || !item.question || item.answer !== null
    || item.branchName || item.worktreePath || item.workerInstanceId || item.verifierInstanceId
    || item.baseCommit || item.checkpointCommit || item.landedCommit || item.round > 0) {
    throw new Error('Only an untouched item with an unanswered readiness question can be rechecked.');
  }
  if (item.question.options.some(option => option.id === 'resume-set-aside')) {
    throw new Error('This question is about retained work. Answer that choice before starting another investigation.');
  }
  guards.triage?.recheckItem(run.id, item.id);
  host.transition(item, 'discovered', {
    question: null,
    detail: `Readiness will be investigated again, requested by ${actor}. No answer or permission was supplied.`,
  });
}
