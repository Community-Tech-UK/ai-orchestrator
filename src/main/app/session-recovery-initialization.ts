import { app } from 'electron';
import type { InstanceManager } from '../instance/instance-manager';
import { getHistoryManager } from '../history/history-manager';
import { archiveRecoverableSessionsToHistory } from '../history/archive-recoverable-sessions';
import {
  historyThreadIdFromLastStopSession,
  ingestMissingLastStopSessionsIntoHistory,
  providerFromLastStopSession,
} from '../history/ingest-missing-last-stop-history';
import { clearToolOutcomes, recordToolOutcome } from '../learning/tool-outcome-store';
import { getOutputStorageManager } from '../memory/output-storage';
import { getLogger } from '../logging/logger';
import { initLastStopSnapshot } from '../session/last-stop-snapshot';
import {
  initializeSessionRecoveryCandidateService,
  setSessionRecoveryStartupArchive,
  wireSessionRecoveryCandidateInvalidation,
  type SessionRecoveryCandidateService,
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
    isSuppressedByHistory: (record) => getHistoryManager().isRecoverySuppressed(record),
    getLiveRecoveryKeys: () => instanceManager.getLiveRecoveryKeys(),
    now: () => Date.now(),
  });
  wireSessionRecoveryCandidateInvalidation(recoveryCandidates, instanceManager);
  const lastStopIngest = ingestMissingLastStopHistory(lastStop.getSnapshot()?.sessions ?? [], continuity);
  // Registered before the first await so no renderer listing can start ahead of it.
  const startupArchive = lastStopIngest.then(() => archiveAutosavesToHistory(recoveryCandidates));
  setSessionRecoveryStartupArchive(startupArchive);
  await lastStopIngest;
  void startupArchive
    .then(() => recoveryCandidates.listCandidates())
    .catch((error) => {
      logger.warn('Session recovery candidate discovery failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Autosaves of top-level sessions that never reached History are copied into
 * it, so nothing is lost and no provider process is started. Only what this
 * cannot safely handle is left in the recovery banner.
 */
async function archiveAutosavesToHistory(
  recoveryCandidates: SessionRecoveryCandidateService,
): Promise<void> {
  try {
    const result = await archiveRecoverableSessionsToHistory({
      candidates: recoveryCandidates,
      archiveInstance: (instance) => getHistoryManager().archiveInstance(instance, 'completed'),
      recordToolOutcome,
      clearToolOutcomes,
    });
    if (result.submitted > 0 || result.failed.length > 0) {
      logger.info('Startup autosave archive finished', {
        submitted: result.submitted,
        skipped: result.skipped,
        failed: result.failed.length,
      });
    }
    for (const failure of result.failed) {
      logger.warn('Autosaved session could not be archived to history', failure);
    }
  } catch (error) {
    logger.warn('Autosave history archive failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function ingestMissingLastStopHistory(
  sessions: Parameters<typeof ingestMissingLastStopSessionsIntoHistory>[0]['sessions'],
  continuity: Pick<SessionContinuityManager, 'loadRecoveryState'>,
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
        if (getHistoryManager().isRecoverySuppressed({
          provider: providerFromLastStopSession(session),
          historyThreadId: historyThreadIdFromLastStopSession(session) ?? undefined,
          sessionId: session.sessionId,
          lastActivityAt: session.lastActivityAt,
        })) return false;
        // Children (sub-agents, Plan Queue workers) are never archived on close
        // either. An unreadable state only means the parent is unknown.
        const state = await continuity.loadRecoveryState(session.instanceId).catch(() => null);
        if (typeof state?.parentId === 'string') return false;
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
