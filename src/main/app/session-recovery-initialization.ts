import { app } from 'electron';
import type { InstanceManager } from '../instance/instance-manager';
import { getHistoryManager } from '../history/history-manager';
import { ingestMissingLastStopSessionsIntoHistory } from '../history/ingest-missing-last-stop-history';
import { getOutputStorageManager } from '../memory/output-storage';
import { getLogger } from '../logging/logger';
import { initLastStopSnapshot } from '../session/last-stop-snapshot';
import {
  initializeSessionRecoveryCandidateService,
  wireSessionRecoveryCandidateInvalidation,
} from '../session/session-recovery-candidate-service';
import type { SessionContinuityManager } from '../session/session-continuity';

const logger = getLogger('SessionRecoveryInitialization');

export async function initializeSessionRecoveryRuntime(
  continuity: SessionContinuityManager,
  instanceManager: InstanceManager,
): Promise<void> {
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
  await ingestMissingLastStopHistory(lastStop.getSnapshot()?.sessions ?? []);
  void recoveryCandidates.listCandidates().catch((error) => {
    logger.warn('Session recovery candidate discovery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function ingestMissingLastStopHistory(
  sessions: Parameters<typeof ingestMissingLastStopSessionsIntoHistory>[0]['sessions'],
): Promise<void> {
  try {
    await getHistoryManager().startupTasks;
    const historyThreads = new Set(
      getHistoryManager().getEntries()
        .map((entry) => entry.historyThreadId?.trim())
        .filter((threadId): threadId is string => Boolean(threadId)),
    );
    const result = await ingestMissingLastStopSessionsIntoHistory({
      sessions,
      hasHistoryThread: (threadId) => historyThreads.has(threadId),
      shouldIngest: async (session) => {
        const messages = await getOutputStorageManager().loadMessages(session.instanceId);
        return messages.some((message) => message.type === 'user' || message.type === 'assistant');
      },
      archiveInstance: (instance) => getHistoryManager().archiveInstance(instance, 'completed'),
    });
    if (result.ingested.length > 0 || result.failed.length > 0) {
      logger.info('Ingested unarchived last-stop sessions into history', {
        ingested: result.ingested.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      });
    }
  } catch (error) {
    logger.warn('Last-stop history ingest failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
