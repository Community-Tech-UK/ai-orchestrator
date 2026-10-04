import { createInstance } from '../../shared/types/instance.types';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { buildVerifiedRecoveryBuffer } from '../instance/lifecycle/continuity-revival';
import type {
  ResolvedRecoveryCandidate,
  SessionRecoveryCandidateService,
} from '../session/session-recovery-candidate-service';

export interface ArchiveRecoverableSessionsDeps {
  candidates: Pick<SessionRecoveryCandidateService, 'listTopLevelCandidates' | 'resolveCandidate'>;
  archiveInstance: (instance: Instance) => Promise<void>;
  recordToolOutcome: (instanceId: string, message: OutputMessage) => void;
  clearToolOutcomes: (instanceId: string) => void;
}

export interface ArchiveRecoverableSessionsResult {
  /** Handed to History; it may still decline a write it finds already covered. */
  submitted: number;
  skipped: number;
  failed: Array<{ instanceId: string; error: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PreparedArchive {
  instance: Instance;
  toolOutcomes: OutputMessage[];
}

/**
 * Build the History archive input for an autosave that never reached History.
 * Returns null when there is nothing History could own: no app thread id, or no
 * messages once History and the autosave are reconciled.
 */
export function buildArchiveInstanceFromRecovery(
  resolved: ResolvedRecoveryCandidate,
): PreparedArchive | null {
  const state = resolved.continuityState;
  const historyThreadId = state.historyThreadId?.trim() || resolved.candidate.historyThreadId?.trim();
  if (!historyThreadId) return null;

  const { initialOutputBuffer, toolOutcomes } = buildVerifiedRecoveryBuffer(resolved);
  if (initialOutputBuffer.length === 0) return null;

  const sessionId = state.sessionId?.trim() || undefined;
  const modelId = state.modelId?.trim() || undefined;
  const instance = createInstance({
    displayName: state.displayName,
    isRenamed: state.isRenamed,
    workingDirectory: state.workingDirectory,
    provider: state.provider ?? resolved.candidate.provider,
    modelOverride: modelId,
    agentId: state.agentId,
    historyThreadId,
    sessionId,
    copilotAccountProfileId: state.copilotAccountProfileId,
  });
  // Keep the original runtime id: History records it as the source, and the
  // archive folds in any output that runtime spilled to disk before it died.
  instance.id = state.instanceId;
  instance.status = 'idle';
  instance.outputBuffer = initialOutputBuffer;
  instance.createdAt = initialOutputBuffer.reduce(
    (earliest, message) => Math.min(earliest, message.timestamp),
    resolved.candidate.lastActivityAt,
  );
  instance.lastActivity = resolved.candidate.lastActivityAt;
  instance.currentModel = modelId;
  instance.copilotRoutingSource = state.copilotRoutingSource;
  instance.accountProfileId = state.accountProfileId;
  instance.accountRoutingSource = state.accountRoutingSource;
  return { instance, toolOutcomes };
}

/**
 * Copy autosaved top-level sessions that are missing from History into it,
 * without starting any provider process. Candidates whose parent is unknown
 * (records written before parent identity was persisted) are left for the user
 * to recover by hand: they may be sub-agents, which History never holds.
 *
 * Every candidate is resolved before anything is archived, because each archive
 * invalidates the candidate cache and a resolve after that would rediscover
 * from disk.
 */
export async function archiveRecoverableSessionsToHistory(
  deps: ArchiveRecoverableSessionsDeps,
): Promise<ArchiveRecoverableSessionsResult> {
  const result: ArchiveRecoverableSessionsResult = { submitted: 0, skipped: 0, failed: [] };
  const prepared: PreparedArchive[] = [];
  for (const candidate of await deps.candidates.listTopLevelCandidates()) {
    try {
      const archive = buildArchiveInstanceFromRecovery(
        await deps.candidates.resolveCandidate(candidate.recoveryKey),
      );
      if (archive) prepared.push(archive);
      else result.skipped++;
    } catch (error) {
      result.failed.push({ instanceId: candidate.sourceInstanceId, error: errorMessage(error) });
    }
  }

  for (const { instance, toolOutcomes } of prepared) {
    try {
      for (const outcome of toolOutcomes) deps.recordToolOutcome(instance.id, outcome);
      await deps.archiveInstance(instance);
      result.submitted++;
    } catch (error) {
      result.failed.push({ instanceId: instance.id, error: errorMessage(error) });
    } finally {
      // archiveInstance clears these itself, except when it skips the write.
      deps.clearToolOutcomes(instance.id);
    }
  }
  return result;
}
