/** Queue dispatch remains separate from run control and persistence. */
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueItemFlow } from './plan-queue-item-flow';
import type { PlanQueueKeptFolders } from './plan-queue-kept-folders';
import type { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueTriage } from './plan-queue-triage';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { reconcileWaitingDocuments } from './plan-queue-readiness';
import { hasPendingLandingCleanup } from './plan-queue-item-landing';
import { isTerminalItemState, itemHoldsWorktree } from './plan-queue-state';
import { queueAdmission } from '../work-admission/queue-admission';
import { pathCompareKey } from '../util/path-helpers';

interface QueuePumpHost extends Pick<PlanQueueFlowHost, 'getRun' | 'getItem' | 'transition' | 'notifyParent' | 'resolveRunParent'> {
  store: PlanQueueStore;
  flow: Pick<PlanQueueItemFlow, 'startItem' | 'startVerification' | 'isWaitingForUsage' | 'isClaimed'> & { keptFolders: Pick<PlanQueueKeptFolders, 'retryDue'> };
  triage: Pick<PlanQueueTriage, 'isStopping' | 'maybeStart'> | null;
  loadAverage(): number[];
  followParent(run: PlanQueueRun): PlanQueueRun;
  isShuttingDown(): boolean;
  isControlling(id: string): boolean;
  finishRun(run: PlanQueueRun, status: 'completed'): void;
  logItemError(item: PlanQueueItem, error: unknown): void;
}

export async function pumpPlanQueue(host: QueuePumpHost): Promise<void> {
    const { store, loadAverage, flow } = host;
    const runs = store.listActiveRuns();
    const [oneMinute = 0, fiveMinute = 0] = loadAverage();
    // Runs in one project folder share its largest effective check cap; each
    // run also keeps its own cap, so a smaller run is not starved by its peers.
    // Other folders have their own cap; Lightest/Light still use the machine count.
    const folderCaps = new Map<string, number>();
    const folderChecks = new Map<string, number>();
    for (const run of runs) {
      const folder = pathCompareKey(run.workspaceCwd);
      folderCaps.set(folder, Math.max(folderCaps.get(folder) ?? 0, queueAdmission(run.config, 0, 0).verificationSlots));
      folderChecks.set(folder, (folderChecks.get(folder) ?? 0) + store.listItems(run.id).filter(item => item.state === 'verifying').length);
    }
    let verifying = runs.flatMap((run) => store.listItems(run.id)).filter((item) => item.state === 'verifying').length;
    let totalJobs = runs.flatMap(run => store.listItems(run.id)).filter(item => itemHoldsWorktree(item.state)).length;
    for (const snapshot of runs) {
      await reconcileWaitingDocuments(host, snapshot);
      if (host.isShuttingDown()) return;
      if (host.isControlling(snapshot.id) || host.triage?.isStopping(snapshot.id)) continue;
      const run = host.followParent(host.getRun(snapshot.id));
      if (run.status !== 'running' && run.status !== 'paused') continue;
      host.resolveRunParent(run);
      const items = store.listItems(run.id);
      if (items.some(hasPendingLandingCleanup)) continue;
      if (run.status === 'running') {
        const policy = queueAdmission(run.config, totalJobs, verifying);
        if (policy.canStartTriage()) host.triage?.maybeStart(run, items);
        const overloaded = oneMinute > policy.maxLoadAverage || fiveMinute > policy.maxLoadAverage;
        if (!overloaded) {
          let inFlight = items.filter((item) => itemHoldsWorktree(item.state)).length;
          for (const item of items.filter((candidate) => candidate.state === 'queued' && !flow.isWaitingForUsage(candidate.id))) {
            if (!queueAdmission(run.config, totalJobs, verifying).canStartWorker(inFlight)) break;
            inFlight += 1;
            totalJobs += 1;
            void flow.startItem(item).catch((error: unknown) => host.logItemError(item, error));
          }
          let runVerifying = items.filter((item) => item.state === 'verifying').length;
          const folder = pathCompareKey(run.workspaceCwd);
          for (const item of items.filter((candidate) => candidate.state === 'awaiting-slot' && !flow.isWaitingForUsage(candidate.id))) {
            if (flow.isClaimed(item.id)) continue;
            const folderVerifying = folderChecks.get(folder) ?? 0;
            if (folderVerifying >= folderCaps.get(folder)! || !queueAdmission(run.config, totalJobs, verifying).canStartCheck(runVerifying)) break;
            verifying += 1;
            runVerifying += 1;
            folderChecks.set(folder, folderVerifying + 1);
            void flow.startVerification(item).catch((error: unknown) => host.logItemError(item, error));
          }
        }
      }
      // A run with no items at all is also finished.
      if (store.listItems(run.id).every((item) => isTerminalItemState(item.state))) {
        host.finishRun(host.getRun(run.id), 'completed');
      }
    }
    // Across every run, ended ones included: a parked attempt's folder outlives its run.
    if (!host.isShuttingDown()) flow.keptFolders.retryDue(store.listItemsWithKeptFolders());
  }
