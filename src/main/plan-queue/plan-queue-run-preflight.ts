import type { PlanQueueRouting } from '@contracts/schemas/plan-queue';
import { currentBranch } from './plan-queue-git';
import { assertRunReady } from './plan-queue-run-readiness';
import type { VerifierSelectInput, VerifierSelection } from './plan-queue-verifier-select';
import type { PlanQueueRun } from './plan-queue.types';

/** Reject impossible routes before a worker spends a round. Queue slots limit its folders. */
export async function preflightPlanQueueRun(input: {
  routing: PlanQueueRouting; workspaceCwd: string; workerProvider: string; workerModel: string | null;
  selectVerifier: (input: VerifierSelectInput) => Promise<VerifierSelection>;
}): Promise<void> {
  for (const worker of input.routing.workers.length ? input.routing.workers : [{ provider: input.workerProvider, model: input.workerModel ?? undefined }]) {
    const checker = await input.selectVerifier({ workerProvider: worker.provider, workerModel: worker.model ?? null,
      workingDirectory: input.workspaceCwd, choices: input.routing.verifiers,
      choicesOverrideLicence: input.routing.checkersChosenBy === 'saved' });
    if (!checker.ok) throw new Error(`This run cannot start: ${checker.reason}. Choose an allowed checker in Settings → Plan Queue, then try again.`);
  }
}

/** Routing only: what a change of workers or checkers needs. */
export function preflightRunRouting(run: PlanQueueRun, selectVerifier: (input: VerifierSelectInput) => Promise<VerifierSelection>): Promise<void> {
  return preflightPlanQueueRun({ routing: run.config.routing ?? { workers: [], verifiers: [] }, workspaceCwd: run.workspaceCwd,
    workerProvider: run.workerProvider ?? 'claude', workerModel: run.workerModel, selectVerifier });
}

/**
 * Resuming a run, or a job in a finished run, runs the start checks again: much can change while it waits (step 5.3).
 * A run that has moved branch would land on the wrong one. Nothing already running is stopped by a refusal.
 */
export async function preflightResumedRun(run: PlanQueueRun, selectVerifier: (input: VerifierSelectInput) => Promise<VerifierSelection>): Promise<void> {
  await preflightRunRouting(run, selectVerifier);
  const branch = await currentBranch(run.workspaceCwd).catch(() => {
    throw new Error(`This run cannot carry on: its folder ${run.workspaceCwd} can't be read as a git repository any more.`);
  });
  if (run.config.baseBranch && branch !== run.config.baseBranch) {
    throw new Error(`This run cannot carry on: the main folder is on ${branch || 'no branch'}, but the run lands its work on ${run.config.baseBranch}. Switch back, then try again.`);
  }
  await assertRunReady(run.workspaceCwd, [...run.config.verifierGates, ...run.config.postMergeGate]);
}
