/** The checker spawn and teardown protocol, separate from item transitions. */
import { requireOwnWorkFolder } from './plan-queue-spawn-guard';
import { InvalidQueueCheckoutError } from './plan-queue-orphan-checkout';
import { isLargeQueueDocument } from './plan-queue-document-policy';
import type { InstanceProvider } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { snapshotTree, type TreeSnapshot } from './plan-queue-git';
import { PlanQueueSpawnRoutingChanged } from './plan-queue-checker-routing';
import { parkAfterVerifierRestoreFailure, PlanQueueSpawnRunPaused, restoreVerifierTree, usageWaitNote } from './plan-queue-run-hold';
import { PlanQueueSpawnOutOfUsage } from './plan-queue-spawn';
import { PlanQueueSpawnStoppedByUser } from './plan-queue-user-close';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueUsageWaits } from './plan-queue-usage-wait';
import type { PlanQueueTurnOutcome } from './plan-queue-instance-tracker';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import type { VerifierSelection } from './plan-queue-verifier-select';
import { recordSessionStart } from './plan-queue-timings';
import { workSourceFor } from './plan-queue-work-sources';

const logger = getLogger('PlanQueueCheckerSpawn');

interface CheckerSpawnDeps {
  host: PlanQueueFlowHost;
  snapshots: Map<string, TreeSnapshot>;
  checkedBase(itemId: string): string;
  usageWaits: PlanQueueUsageWaits;
  prompt(item: PlanQueueItem, run: PlanQueueRun, baseBranch: string): Promise<string>;
  hold(item: PlanQueueItem): Promise<void>;
  select(item: PlanQueueItem, baseBranch: string): Promise<void>;
  stop(id: string): Promise<void>;
  forgetCheck(itemId: string): void;
  erroredRound(item: PlanQueueItem, reason: string): Promise<void>;
  onVerifierOutcome(id: string, outcome: PlanQueueTurnOutcome): Promise<void>;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export async function spawnQueueChecker(deps: CheckerSpawnDeps, waiting: PlanQueueItem, run: PlanQueueRun,
  baseBranch: string, choice: Extract<VerifierSelection, { ok: true }>['choice']): Promise<void> {
    let item = waiting;
    try {
      const worktreePath = await requireOwnWorkFolder(item, run.workspaceCwd);
      deps.snapshots.set(item.id, await snapshotTree(worktreePath));
      const mainTip = deps.checkedBase(item.id);
      item = deps.host.save({ ...item, verifiedMainCommit: mainTip });
      const instance = await deps.host.instances.createInstance({
        displayName: `Queue verifier · ${workSourceFor(item.sourceKind).displayName(item)} (round ${item.round + 1})`,
        isRenamed: true,
        parentId: deps.host.liveParentId(run),
        workingDirectory: worktreePath,
        initialPrompt: await deps.prompt(item, run, baseBranch),
        provider: choice.provider as InstanceProvider,
        ...(choice.modelOverride ? { modelOverride: choice.modelOverride } : {}),
        ...(choice.copilotProfileId ? { copilotAccountProfileId: choice.copilotProfileId } : {}),
        ...(choice.accountProfileIds?.length ? { allowedAccountProfileIds: choice.accountProfileIds } : {}),
        yoloMode: true,
        metadata: { planQueueLargeDocument: isLargeQueueDocument(item.sourceRef), planQueueRunId: run.id, planQueueItemId: item.id, planQueueRole: 'verifier', planQueueRound: item.round, planQueueRouting: JSON.stringify(run.config.routing) },
      });
      deps.host.registerRole(instance.id, { role: 'verifier', runId: run.id, itemId: item.id });
      recordSessionStart(deps.host, item.id, 'checker', instance.id, choice.provider, choice.modelOverride ?? deps.host.instances.getInstance(instance.id)?.currentModel);
      deps.host.save({ ...deps.host.getItem(item.id), verifierInstanceId: instance.id, heldAt: null, detail: null });
      deps.host.tracker.track(instance.id);
      instance.readyPromise?.catch((error: unknown) => {
        void deps.onVerifierOutcome(instance.id, { kind: 'failed', reason: `verifier failed to start: ${errorMessage(error)}` })
          .catch((failure: unknown) => logger.warn('Plan queue: handling checker startup failure failed', { instanceId: instance.id, error: errorMessage(failure) }));
      });
    } catch (error) {
      if (deps.host.tracker.isShuttingDown()) {
        deps.snapshots.delete(item.id);
        return;
      }
      if (error instanceof PlanQueueSpawnRunPaused) {
        const current = deps.host.getItem(item.id);
        await deps.hold(error.instanceId ? deps.host.save({ ...current, verifierInstanceId: error.instanceId }) : current); return;
      }
      if (error instanceof InvalidQueueCheckoutError) {
        deps.snapshots.delete(item.id);
        parkAfterVerifierRestoreFailure(deps.host, deps.host.getItem(item.id), error, 'No checker was started: the saved work folder is not this job\'s own folder.');
        deps.forgetCheck(item.id);
        return;
      }
      if (error instanceof PlanQueueSpawnRoutingChanged) { await deps.select(deps.host.getItem(item.id), baseBranch); return; }
      if (error instanceof PlanQueueSpawnOutOfUsage) {
        // No checker started, so the tree is untouched and no round is counted.
        deps.snapshots.delete(item.id);
        deps.host.transition(deps.host.getItem(item.id), 'awaiting-slot', { detail: usageWaitNote(error.message) });
        deps.usageWaits.start(item.id, error, 'check');
        return;
      }
      if (error instanceof PlanQueueSpawnStoppedByUser) {
        if (error.instanceId) {
          item = deps.host.save({ ...deps.host.getItem(item.id), verifierInstanceId: error.instanceId });
          await deps.stop(error.instanceId);
        }
        try { await restoreVerifierTree(item, run.workspaceCwd, deps.snapshots.get(item.id)); }
        catch (restoreError) {
          const current = deps.host.getItem(item.id);
          if (current.workerInstanceId) await deps.stop(current.workerInstanceId);
          deps.snapshots.delete(item.id);
          parkAfterVerifierRestoreFailure(deps.host, current, restoreError, 'Its checker was closed.');
          deps.forgetCheck(item.id);
          return;
        }
      }
      deps.snapshots.delete(item.id);
      if (error instanceof PlanQueueSpawnStoppedByUser) {
        deps.host.transition(deps.host.getItem(item.id), 'awaiting-slot', { verifierInstanceId: null, detail: 'Its checker was closed; it will be checked again.' });
      } else await deps.erroredRound(deps.host.getItem(item.id), `Could not start the verifier: ${errorMessage(error)}`);
    }
}
