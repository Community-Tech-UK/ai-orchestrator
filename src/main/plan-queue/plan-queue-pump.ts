/** Queue dispatch remains separate from run control and persistence. */
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueCheckWait } from '@contracts/schemas/plan-queue';
import type { PlanQueueDiscardedRefs } from './plan-queue-discard';
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
  flow: Pick<PlanQueueItemFlow, 'startItem' | 'startVerification' | 'isWaitingForUsage' | 'isClaimed' | 'checklistTurns' | 'breaker' | 'finishLandingCleanup'> & { keptFolders: Pick<PlanQueueKeptFolders, 'retryDue'>; discardedRefs: Pick<PlanQueueDiscardedRefs, 'sweepDue'> };
  triage: Pick<PlanQueueTriage, 'isStopping' | 'maybeStart'> | null;
  loadAverage(): number[];
  followParent(run: PlanQueueRun): PlanQueueRun;
  isShuttingDown(): boolean;
  isControlling(id: string): boolean;
  finishRun(run: PlanQueueRun, status: 'completed'): void;
  logItemError(item: PlanQueueItem, error: unknown): void;
  announceRun(runId: string): void;
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
    store.waits.prune(new Set(runs.flatMap(run => store.listItems(run.id)).filter(item => item.state === 'queued' || item.state === 'awaiting-slot').map(item => item.id)));
    const runChecks = new Map<string, number>();
    const whyNoCheck = (run: PlanQueueRun, checklist: boolean): PlanQueueCheckWait | null => {
      if (!flow.breaker.canStart(run)) return 'run-on-hold';
      const folder = pathCompareKey(run.workspaceCwd);
      if ((folderChecks.get(folder) ?? 0) >= folderCaps.get(folder)!) return 'other-checks';
      const policy = queueAdmission(run.config, totalJobs, verifying);
      return policy.whyNoCheck(runChecks.get(run.id) ?? 0) ?? (checklist ? policy.whyNoChecklist(flow.checklistTurns.size) : null);
    };
    const explainedRuns = new Set<string>();
    const explain = (item: PlanQueueItem, why: PlanQueueCheckWait): void => { if (store.waits.explain(item.id, why)) explainedRuns.add(item.runId); };
    const noCheckYet = (item: PlanQueueItem, why: PlanQueueCheckWait): void => { store.waits.blocked(item.id); explain(item, why); };
    const startCheck = (item: PlanQueueItem, run: PlanQueueRun): void => {
      flow.breaker.started(run, item.id);
      store.waits.started(item, 'check');
      verifying += 1;
      runChecks.set(run.id, (runChecks.get(run.id) ?? 0) + 1);
      const folder = pathCompareKey(run.workspaceCwd);
      folderChecks.set(folder, (folderChecks.get(folder) ?? 0) + 1);
      try { void flow.startVerification(item).catch((error: unknown) => host.logItemError(item, error)); }
      catch (error) { host.logItemError(item, error); }
    };
    const checklists: { item: PlanQueueItem; run: PlanQueueRun }[] = [];
    for (const snapshot of runs) {
      await reconcileWaitingDocuments(host, snapshot);
      if (host.isShuttingDown()) return;
      if (host.isControlling(snapshot.id) || host.triage?.isStopping(snapshot.id)) continue;
      const run = host.followParent(host.getRun(snapshot.id));
      if (run.status !== 'running' && run.status !== 'paused') continue;
      host.resolveRunParent(run);
      const items = store.listItems(run.id);
      const awaitingChecks = items.filter(item => item.state === 'awaiting-slot');
      const cleanups = items.filter(hasPendingLandingCleanup);
      if (cleanups.length) {
        // Nothing new starts until this is done, and only a pass can retry it: a run reopened with such a row would otherwise never move.
        if (run.status === 'running') for (const item of cleanups) void flow.finishLandingCleanup(item.id);
        for (const item of awaitingChecks) explain(item, run.status === 'running' ? 'tidying-up' : 'run-on-hold');
        continue;
      }
      if (run.status === 'running') {
        const policy = queueAdmission(run.config, totalJobs, verifying);
        if (policy.canStartTriage() && flow.breaker.canStart(run)) {
          if (items.some(item => item.state === 'discovered')) flow.breaker.started(run, null);
          host.triage?.maybeStart(run, items);
        }
        const overloaded = oneMinute > policy.maxLoadAverage || fiveMinute > policy.maxLoadAverage;
        if (!overloaded) {
          let inFlight = items.filter((item) => itemHoldsWorktree(item.state)).length;
          for (const item of items.filter((candidate) => candidate.state === 'queued' && !flow.isWaitingForUsage(candidate.id))) {
            if (!flow.breaker.canStart(run) || !queueAdmission(run.config, totalJobs, verifying).canStartWorker(inFlight)) { store.waits.blocked(item.id); continue; }
            flow.breaker.started(run, item.id);
            store.waits.started(item, 'worker');
            inFlight += 1;
            totalJobs += 1;
            void flow.startItem(item).catch((error: unknown) => host.logItemError(item, error));
          }
          runChecks.set(run.id, items.filter((item) => item.state === 'verifying').length);
          for (const item of awaitingChecks) {
            if (flow.isWaitingForUsage(item.id)) { explain(item, 'trying-later'); continue; }
            if (flow.isClaimed(item.id)) { explain(item, 'checked-together'); continue; }
            // Checklists are chosen across every run below. Runs are visited oldest first, so a busy old run would otherwise always win.
            if (run.config.verifierGates.length) { checklists.push({ item, run }); continue; }
            const why = whyNoCheck(run, false);
            if (why) noCheckYet(item, why); else startCheck(item, run);
          }
        } else for (const item of awaitingChecks) explain(item, 'computer-busy');
      } else for (const item of awaitingChecks) explain(item, 'run-on-hold');
      // A run with no items at all is also finished.
      if (store.listItems(run.id).every((item) => isTerminalItemState(item.state))) {
        host.finishRun(host.getRun(run.id), 'completed');
      }
    }
    // The job that has waited longest goes first. Earlier passes of this loop awaited, so judge each as it is now.
    const waited = ({ item }: { item: PlanQueueItem }): number => store.waits.waitingSince(item.id) ?? item.updatedAt;
    for (const { item: listed, run } of checklists.sort((a, b) => waited(a) - waited(b) || a.item.id.localeCompare(b.item.id))) {
      const item = host.getItem(listed.id);
      if (host.isShuttingDown() || item.state !== 'awaiting-slot' || host.getRun(run.id).status !== 'running' || flow.isClaimed(item.id)
        || host.isControlling(run.id) || host.triage?.isStopping(run.id)) continue;
      const why = whyNoCheck(host.getRun(run.id), true);
      if (why) noCheckYet(item, why); else startCheck(item, host.getRun(run.id));
    }
    for (const runId of explainedRuns) host.announceRun(runId);
    // Across every run, ended ones included: a parked attempt's folder outlives its run.
    if (!host.isShuttingDown()) {
      flow.keptFolders.retryDue(store.listItemsWithKeptFolders());
      flow.discardedRefs.sweepDue(() => store.listFoldersWithDiscardedItems());
    }
  }
