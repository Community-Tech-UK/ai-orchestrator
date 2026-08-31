import { app } from 'electron';
import type { InstanceManager } from '../instance/instance-manager';
import { getHistoryManager } from '../history/history-manager';
import { getLogger } from '../logging/logger';
import { initLastStopSnapshot } from '../session/last-stop-snapshot';
import {
  initializeSessionRecoveryCandidateService,
  wireSessionRecoveryCandidateInvalidation,
} from '../session/session-recovery-candidate-service';
import type { SessionContinuityManager } from '../session/session-continuity';

const logger = getLogger('SessionRecoveryInitialization');
export function initializeSessionRecoveryRuntime(
  continuity: SessionContinuityManager,
  instanceManager: InstanceManager,
): void {
  const lastStop = initLastStopSnapshot(`${app.getPath('userData')}/session-continuity`);
  const recoveryCandidates = initializeSessionRecoveryCandidateService({
    getSnapshot: () => lastStop.getSnapshot(),
    waitForContinuityReady: () => continuity.waitForRecoveryDiscoveryReady(),
    listContinuityMetadata: (modifiedSince, preferredInstanceIds) =>
      continuity.listContinuityRecoveryMetadata(modifiedSince, preferredInstanceIds),
    loadContinuityState: (sourceInstanceId) => continuity.loadRecoveryState(sourceInstanceId),
    waitForHistoryReady: () => getHistoryManager().startupTasks,
    getHistoryCoverage: (identities) => getHistoryManager().getRecoveryCoverage(identities),
    loadHistoryConversation: (entryId) => getHistoryManager().loadConversation(entryId),
    getLiveRecoveryKeys: () => instanceManager.getLiveRecoveryKeys(),
    now: () => Date.now(),
  });
  wireSessionRecoveryCandidateInvalidation(recoveryCandidates, instanceManager);
  void recoveryCandidates.listCandidates().catch((error) => {
    logger.warn('Session recovery candidate discovery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
