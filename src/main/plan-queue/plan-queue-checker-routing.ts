/** Checker selection can yield; repeat it if James edits routing meanwhile. */
import type { PlanQueueFlowHost } from './plan-queue-host';
import { PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import type { PlanQueueItem } from './plan-queue.types';
import type { VerifierSelection } from './plan-queue-verifier-select';

export class PlanQueueSpawnRoutingChanged extends Error {
  constructor() { super('Plan Queue routing changed while this checker was starting.'); }
}

export async function selectCurrentQueueVerifier(host: PlanQueueFlowHost, item: PlanQueueItem) {
  while (true) {
    const run = host.getRun(item.runId);
    if (run.status === 'paused') throw new PlanQueueSpawnRunPaused();
    const worker = item.workerInstanceId ? host.instances.getInstance(item.workerInstanceId) : undefined;
    // Provider and model always come from one source: the live worker session, else (after a
    // restart or pause) what the item's worker ran on, else the run's worker.
    const ranOn = worker?.provider ? { provider: worker.provider, model: worker.currentModel ?? null }
      : item.workerProvider ? { provider: item.workerProvider, model: item.workerModel ?? null }
        : { provider: run.workerProvider ?? 'claude', model: run.workerModel };
    // A failed lookup (usage, provider detection) parks the item with the reason; it must never stay "verifying" with no checker.
    const selection: VerifierSelection = await host.selectVerifier({
      workerProvider: ranOn.provider,
      workerModel: ranOn.model,
      workingDirectory: item.worktreePath ?? run.workspaceCwd,
      choices: run.config.routing?.verifiers,
      choicesOverrideLicence: run.config.routing?.checkersChosenBy === 'saved',
    }).catch((error: unknown) => ({ ok: false, reason: `could not choose a checker: ${error instanceof Error ? error.message : String(error)}` }));
    const current = host.getRun(item.runId);
    if (current.status === 'paused') throw new PlanQueueSpawnRunPaused();
    if (JSON.stringify(current.config.routing) === JSON.stringify(run.config.routing)) return { run: current, selection };
  }
}
