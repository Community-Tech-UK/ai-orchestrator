import type { PlanQueueRouting } from '@contracts/schemas/plan-queue';
import type { VerifierSelectInput, VerifierSelection } from './plan-queue-verifier-select';

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
