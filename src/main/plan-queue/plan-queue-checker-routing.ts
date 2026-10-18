/** Checker selection can yield; repeat it if James edits routing meanwhile. */
import type { PlanQueueFlowHost } from './plan-queue-host';
import { PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import type { PlanQueueItem } from './plan-queue.types';

export class PlanQueueSpawnRoutingChanged extends Error {
  constructor() { super('Plan Queue routing changed while this checker was starting.'); }
}

export async function selectCurrentQueueVerifier(host: PlanQueueFlowHost, item: PlanQueueItem) {
  while (true) {
    const run = host.getRun(item.runId);
    if (run.status === 'paused') throw new PlanQueueSpawnRunPaused();
    const worker = item.workerInstanceId ? host.instances.getInstance(item.workerInstanceId) : undefined;
    const selection = await host.selectVerifier({
      workerProvider: worker?.provider ?? run.workerProvider ?? 'claude',
      workerModel: worker?.currentModel ?? run.workerModel,
      workingDirectory: item.worktreePath ?? run.workspaceCwd,
      choices: run.config.routing?.verifiers,
      choicesOverrideLicence: run.config.routing?.checkersChosenBy === 'saved',
    });
    const current = host.getRun(item.runId);
    if (current.status === 'paused') throw new PlanQueueSpawnRunPaused();
    if (JSON.stringify(current.config.routing) === JSON.stringify(run.config.routing)) return { run: current, selection };
  }
}
