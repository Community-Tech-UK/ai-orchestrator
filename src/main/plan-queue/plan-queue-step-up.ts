/**
 * Plan Queue step-up: a document whose worker failed every verification round
 * goes, once, to the run's step-up choice (for example Opus after Haiku)
 * instead of parking, but only when its last verdict lists a `code` finding (step 5.4): a stronger worker cannot
 * supply a missing setting or a human's answer, so those park.
 *
 * The item's `steppedUpAt` is written before the new worker starts. Every
 * worker spawned for the item afterwards carries `planQueueSteppedUp`, which
 * routes it to the step-up choice (`queueWorkerChoices`): crash respawn, boot
 * recovery, Pause/Resume and James's Resume of a parked item all keep it, and
 * the saved mark is what stops a second handover.
 */

import * as path from 'path';
import type { PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import { findingKind } from './plan-queue-deferred-checks';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { buildStepUpInstruction, buildStepUpPrompt } from './plan-queue-prompts';
import { describeRouteChoice } from './plan-queue-routing';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

export interface PlanQueueStepUpDeps {
  host: PlanQueueFlowHost;
  stopInstance(instanceId: string): Promise<void>;
  /** Start a worker for the item, already in `fixing`; holds or parks it itself when that fails. */
  spawnWorker(item: PlanQueueItem, prompt: string): Promise<void>;
  promptContext(run: PlanQueueRun, item: PlanQueueItem): Promise<Parameters<typeof buildStepUpPrompt>[0]>;
}

/**
 * True when a document out of rounds should be handed over rather than parked (step 5.4): the run has a step-up
 * choice, the item has not had its handover, and the last verdict lists a `code` finding. A stronger worker
 * can only help with code, so a verdict with no findings, or only environment and needs-human ones, parks instead
 * (`parkingForFailure` sets the latter aside before this is asked; a FAIL with no findings reaches the round limit).
 */
export function canStepUp(run: PlanQueueRun, item: PlanQueueItem, verdict: Pick<PlanQueueVerdict, 'findings'>): boolean {
  return Boolean(run.config.routing?.stepUp) && !item.steppedUpAt && verdict.findings.some(finding => findingKind(finding) === 'code');
}

/**
 * Hand the item to the run's step-up choice. Runs under the item lock, after
 * the verifier has stopped; the worker is between turns and its round is
 * already checkpointed on the branch.
 */
export async function stepUpItem(deps: PlanQueueStepUpDeps, item: PlanQueueItem, failedRounds: number, verdict: PlanQueueVerdict): Promise<void> {
  const { host } = deps;
  const run = host.getRun(item.runId);
  const stepUp = run.config.routing?.stepUp;
  if (!stepUp) throw new Error(`Plan queue run ${run.id} has no step-up choice`);
  if (item.workerInstanceId) await deps.stopInstance(item.workerInstanceId);
  const choice = describeRouteChoice(stepUp);
  // The task is also the pending instruction, so a Pause before the new session starts keeps it.
  const prompt = buildStepUpPrompt(await deps.promptContext(run, { ...item, pendingInstruction: null }), failedRounds, verdict.findings);
  const saved = host.transition(item, 'fixing', {
    steppedUpAt: Date.now(), workerSession: undefined, round: 0, erroredRounds: 0, verdict, workerInstanceId: null,
    pendingInstruction: buildStepUpInstruction(failedRounds, verdict.findings),
    detail: `Handed to a stronger worker (${choice}) after ${failedRounds} failed check(s).`,
  });
  await deps.spawnWorker(saved, prompt);
  // A worker that could not start parks the item; say so rather than promise rounds it is not getting.
  const parked = host.getItem(saved.id).state === 'parked';
  host.notifyParent(
    host.getRun(saved.runId),
    `Plan Queue: ${path.basename(saved.documentPath)} failed its checks in all ${failedRounds} verification round(s), so it was handed to the stronger worker James chose (${choice}). `
      + (parked
        ? 'That worker could not start, so the document is parked; Resume continues with the stronger worker.'
        : `That worker gets up to ${run.config.maxRounds} more round(s). A document is handed over once; if it still fails, it parks for James.`),
  );
}
