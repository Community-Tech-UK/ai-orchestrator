import type { InstanceManager } from '../instance/instance-manager';
import { getWorkAdmission } from '../work-admission/work-admission';
import { getActiveConsultCount } from '../work-admission/consult-admission';
import { getPlanQueueStoreIfInitialized } from '../plan-queue/plan-queue-bootstrap';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getCampaignCoordinator } from '../orchestration/campaign-coordinator';
import { getAutomationStore } from '../automations';
import { getRepoJobService } from '../repo-jobs/repo-job-service';
import { getBrowserExtensionCommandStore } from '../browser-gateway/browser-extension-command-store';
import { getRemoteCdpTunnelClient } from '../remote-node/remote-cdp-tunnel';
import { getRemoteTerminalManager } from '../remote-node/remote-terminal-manager';
import { getWorkerNodeConnectionServer } from '../remote-node/worker-node-connection';
import { getWorkerModeRuntimeService } from '../remote-node/worker-mode-runtime-service';
import { hasPendingInstanceContinuation } from '../instance/instance-continuation-runtime';
import { getInstanceAsyncWorkRegistry } from '../instance/instance-async-work-registry';
import { isAdapterOnLoan, isRuntimeChangeInFlight } from '../instance/lifecycle/adapter-loan-registry';
import { hasPendingInitialPrompt } from '../instance/lifecycle/initial-prompt-recovery';
import { getSessionQueueService } from '../session/session-queue-service';
import { SessionRevivalService } from '../session/session-revival-service';
import { waitForSessionRecoveryStartupArchive } from '../session/session-recovery-candidate-service';
import { isRemoteNodeReachable } from '../ipc/handlers/remote-node-check';
import { getHistoryManager } from '../history/history-manager';
import type { SourceUpdateMaintenanceDependencies } from './source-update-maintenance';

/** Read only the existing engines' own activity, never a separate restart policy ledger. */
export function createMaintenanceDependencies(manager: InstanceManager): SourceUpdateMaintenanceDependencies {
  const admission = getWorkAdmission();
  const revival = new SessionRevivalService(manager);
  return {
    admission,
    hasActiveWork: () => {
      const queue = getPlanQueueStoreIfInitialized();
      const browser = getBrowserExtensionCommandStore();
      return manager.hasPendingSourceUpdateOperations() || getActiveConsultCount() > 0
        || Object.values(admission.getCounts()).some(count => count > 0)
        || Boolean(queue?.hasActiveWork() || queue?.countAutomaticLandings()
          || queue?.listActiveRuns().some(run => run.status === 'running'))
        || getLoopCoordinator().getActiveLoops().some(loop => loop.status === 'running' || loop.inFlightIteration)
        || getCampaignCoordinator().listRunningCampaigns().length > 0
        || getAutomationStore().listActiveRuns().length > 0
        || getRepoJobService().getActiveJobs().length > 0
        || browser.listActiveQueueKeys().some(key => {
          const snapshot = browser.describeQueue(key);
          return snapshot.queuedCount > 0 || snapshot.inFlightCount > 0;
        })
        || getRemoteTerminalManager().activeSessionCount() > 0
        || getRemoteCdpTunnelClient().activeSessionCount() > 0
        || getWorkerNodeConnectionServer().hasActiveWork()
        // An app-owned worker is stopped on normal quit. Its own activity cannot be proved here.
        || getWorkerModeRuntimeService().status().state === 'running';
    },
    hasSessionWork: id => {
      const instance = manager.getInstance(id);
      return Boolean(instance?.executionLocation?.type === 'remote' && !isRemoteNodeReachable(instance.executionLocation.nodeId))
        || isAdapterOnLoan(id) || isRuntimeChangeInFlight(id)
        || getInstanceAsyncWorkRegistry().hasInhibitor(id) || hasPendingInstanceContinuation(id) || manager.hasActiveSessionWork(id)
        || Boolean(instance && hasPendingInitialPrompt(instance)) || getSessionQueueService().hasQueuedMessages(id);
    },
    archive: instance => getHistoryManager().archiveInstance(instance, 'completed', { allowSameInstanceRearchive: true }),
    findHistoryEntry: instance => getHistoryManager().getEntries().find(entry => entry.historyThreadId === instance.historyThreadId),
    revive: async request => {
      await getHistoryManager().startupTasks;
      await waitForSessionRecoveryStartupArchive();
      const entry = getHistoryManager().getEntries().find(candidate => candidate.id === request.historyEntryId);
      if (entry?.executionLocation?.type === 'remote' && !isRemoteNodeReachable(entry.executionLocation.nodeId)) {
        throw new Error('The conversation computer has not reconnected yet.');
      }
      return revival.revive(request);
    },
  };
}
