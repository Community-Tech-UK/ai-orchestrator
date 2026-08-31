import type { ConversationData } from '../../shared/types/history.types';
import type { InstanceProvider } from '../../shared/types/instance.types';
import type { SessionRecoveryCandidate } from '../../shared/types/session-recovery.types';
import type { LastStopSnapshot } from './last-stop-snapshot';
import type { SessionState } from './session-continuity.types';

export const RECOVERY_FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const RECOVERY_COVERAGE_SKEW_MS = 5_000;
export const MAX_SESSION_RECOVERY_CANDIDATES = 50;

export interface ContinuityStateFileGeneration {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export interface ContinuityRecoveryMetadata {
  recoveryKey: string;
  sourceInstanceId: string;
  historyThreadId?: string;
  sessionId?: string;
  provider: InstanceProvider;
  modelId?: string;
  displayName?: string;
  workingDirectory?: string;
  lastActivityAt: number;
  modifiedAt: number;
  messageCount: number;
  hasUserPrompt: boolean;
  hasAssistantOutput: boolean;
  nativeResumeAvailable: boolean;
  stateFileGeneration?: ContinuityStateFileGeneration;
}

export interface RecoveryHistoryIdentity {
  recoveryKey: string;
  provider: InstanceProvider;
  historyThreadId?: string;
  sessionId?: string;
}

export interface HistoryRecoveryCoverage {
  recoveryKey: string;
  historyEntryId: string;
  provider?: InstanceProvider;
  historyThreadId?: string;
  sessionId?: string;
  coveredThrough: number;
  messageCount: number;
}

export interface ResolvedRecoveryCandidate {
  candidate: SessionRecoveryCandidate;
  continuityState: SessionState;
  historyConversation: ConversationData | null;
}

export interface SessionRecoveryCandidateDependencies {
  getSnapshot(): LastStopSnapshot | null;
  waitForContinuityReady(): Promise<void>;
  listContinuityMetadata(
    modifiedSince: number,
    preferredInstanceIds: readonly string[],
  ): Promise<ContinuityRecoveryMetadata[]>;
  loadContinuityState(sourceInstanceId: string): Promise<SessionState | null>;
  waitForHistoryReady(): Promise<void>;
  getHistoryCoverage(
    identities: readonly RecoveryHistoryIdentity[],
  ): Promise<ReadonlyMap<string, HistoryRecoveryCoverage>>;
  loadHistoryConversation(entryId: string): Promise<ConversationData | null>;
  getLiveRecoveryKeys(): ReadonlySet<string>;
  now(): number;
}

interface CandidateRecord {
  candidate: SessionRecoveryCandidate;
  historyEntryId?: string;
  shutdownLive: boolean;
}

export function getRecoveryIdentityKeys(identity: {
  recoveryKey?: string;
  provider: InstanceProvider;
  historyThreadId?: string;
  sessionId?: string;
  sourceInstanceId?: string;
}): string[] {
  const keys = new Set<string>();
  const recoveryKey = typeof identity.recoveryKey === 'string'
    ? identity.recoveryKey.trim()
    : '';
  const historyThreadId = typeof identity.historyThreadId === 'string'
    ? identity.historyThreadId.trim()
    : '';
  const sessionId = typeof identity.sessionId === 'string'
    ? identity.sessionId.trim()
    : '';
  const sourceInstanceId = typeof identity.sourceInstanceId === 'string'
    ? identity.sourceInstanceId.trim()
    : '';
  if (recoveryKey) keys.add(recoveryKey);
  if (historyThreadId) {
    keys.add(`history:${identity.provider}:${historyThreadId}`);
  }
  if (sessionId) {
    keys.add(`session:${identity.provider}:${sessionId}`);
  }
  if (sourceInstanceId) {
    keys.add(`instance:${sourceInstanceId}`);
  }
  return Array.from(keys);
}

function compareMetadata(
  left: ContinuityRecoveryMetadata,
  right: ContinuityRecoveryMetadata,
): number {
  const byActivity = right.lastActivityAt - left.lastActivityAt;
  if (byActivity !== 0) return byActivity;
  const byKey = left.recoveryKey.localeCompare(right.recoveryKey);
  if (byKey !== 0) return byKey;
  return left.sourceInstanceId.localeCompare(right.sourceInstanceId);
}

function compareCandidateRecords(left: CandidateRecord, right: CandidateRecord): number {
  const byActivity = right.candidate.lastActivityAt - left.candidate.lastActivityAt;
  if (byActivity !== 0) return byActivity;
  const byKey = left.candidate.recoveryKey.localeCompare(right.candidate.recoveryKey);
  if (byKey !== 0) return byKey;
  return left.candidate.sourceInstanceId.localeCompare(right.candidate.sourceInstanceId);
}

export class SessionRecoveryCandidateService {
  private cachedRecords: CandidateRecord[] | null = null;
  private discoveryEpoch = 0;

  constructor(private readonly deps: SessionRecoveryCandidateDependencies) {}

  async listCandidates(): Promise<SessionRecoveryCandidate[]> {
    const records = await this.getCandidateRecords();
    return records.map((record) => record.candidate);
  }

  async resolveCandidate(recoveryKey: string): Promise<ResolvedRecoveryCandidate> {
    const record = (await this.getCandidateRecords())
      .find((item) => item.candidate.recoveryKey === recoveryKey);
    if (!record) {
      throw new Error('Recovery candidate is unavailable');
    }

    const continuityState = await this.deps.loadContinuityState(
      record.candidate.sourceInstanceId,
    );
    if (!continuityState) {
      this.invalidate();
      throw new Error('Recovery source is unavailable');
    }

    const historyConversation = record.historyEntryId
      ? await this.deps.loadHistoryConversation(record.historyEntryId)
      : null;

    return { candidate: record.candidate, continuityState, historyConversation };
  }

  invalidate(): void {
    this.discoveryEpoch++;
    this.cachedRecords = null;
  }

  private async getCandidateRecords(): Promise<CandidateRecord[]> {
    if (this.cachedRecords) return this.cachedRecords;
    const discoveryEpoch = this.discoveryEpoch;
    await this.deps.waitForContinuityReady();
    if (this.cachedRecords) return this.cachedRecords;
    if (discoveryEpoch !== this.discoveryEpoch) return this.getCandidateRecords();

    const snapshot = this.deps.getSnapshot();
    const snapshotWrittenAt = snapshot?.writtenAt ?? 0;
    const metadata = await this.deps.listContinuityMetadata(
      this.deps.now() - RECOVERY_FALLBACK_WINDOW_MS,
      snapshot?.sessions.map((session) => session.instanceId) ?? [],
    );
    const byKey = new Map<string, ContinuityRecoveryMetadata>();
    for (const record of metadata.sort(compareMetadata)) {
      if (!byKey.has(record.recoveryKey)) byKey.set(record.recoveryKey, record);
    }

    const shutdownLiveKeys = new Set<string>();
    for (const session of snapshot?.sessions ?? []) {
      if (session.isLive) shutdownLiveKeys.add(session.recoveryKey);
      const fromSnapshot: ContinuityRecoveryMetadata = {
        recoveryKey: session.recoveryKey,
        sourceInstanceId: session.instanceId,
        historyThreadId: session.historyThreadId,
        sessionId: session.sessionId,
        provider: (session.provider ?? 'claude') as InstanceProvider,
        modelId: session.modelId,
        displayName: session.displayName,
        workingDirectory: session.workingDirectory,
        lastActivityAt: session.lastActivityAt,
        modifiedAt: snapshotWrittenAt,
        messageCount: session.messageCount,
        hasUserPrompt: session.messageCount > 0 && !session.hasAssistantOutput,
        hasAssistantOutput: session.hasAssistantOutput,
        nativeResumeAvailable: Boolean(session.sessionId || session.resumeCursor),
      };
      const existing = byKey.get(session.recoveryKey);
      if (!existing || compareMetadata(fromSnapshot, existing) < 0) {
        byKey.set(session.recoveryKey, fromSnapshot);
      }
    }

    const liveKeys = this.deps.getLiveRecoveryKeys();
    const eligible = Array.from(byKey.values()).filter((record) =>
      record.provider !== 'gemini'
      && !getRecoveryIdentityKeys(record).some((key) => liveKeys.has(key))
      && record.messageCount > 0
      && (record.hasUserPrompt || record.hasAssistantOutput))
      .sort(compareMetadata);
    const coverageRecords = [
      ...eligible.filter((record) => shutdownLiveKeys.has(record.recoveryKey)),
      ...eligible.filter((record) => !shutdownLiveKeys.has(record.recoveryKey))
        .slice(0, MAX_SESSION_RECOVERY_CANDIDATES),
    ];
    const identities = coverageRecords.map((record) => ({
      recoveryKey: record.recoveryKey,
      provider: record.provider,
      historyThreadId: record.historyThreadId,
      sessionId: record.sessionId,
    }));
    await this.deps.waitForHistoryReady();
    const coverage = await this.deps.getHistoryCoverage(identities);

    const candidates: CandidateRecord[] = [];
    for (const record of coverageRecords) {
      const history = coverage.get(record.recoveryKey);
      const isNewer = history
        ? record.lastActivityAt > history.coveredThrough + RECOVERY_COVERAGE_SKEW_MS
        : false;
      if (history && !isNewer) continue;

      const reason = history
        ? 'newer-than-history' as const
        : record.hasAssistantOutput
          ? 'unarchived' as const
          : 'draft-only' as const;
      const recoveredMessageCount = history
        ? Math.max(1, record.messageCount - history.messageCount)
        : record.messageCount;
      candidates.push({
        candidate: {
          recoveryKey: record.recoveryKey,
          sourceInstanceId: record.sourceInstanceId,
          historyThreadId: record.historyThreadId,
          provider: record.provider,
          modelId: record.modelId,
          displayName: record.displayName,
          workingDirectory: record.workingDirectory,
          lastActivityAt: record.lastActivityAt,
          historyCoveredThrough: history?.coveredThrough,
          recoveredMessageCount,
          reason,
          nativeResumeAvailable: record.nativeResumeAvailable,
        },
        historyEntryId: history?.historyEntryId,
        shutdownLive: shutdownLiveKeys.has(record.recoveryKey),
      });
    }

    candidates.sort(compareCandidateRecords);
    const shutdownLive = candidates.filter((record) => record.shutdownLive);
    const ordinary = candidates.filter((record) => !record.shutdownLive);
    if (discoveryEpoch !== this.discoveryEpoch) return this.getCandidateRecords();
    this.cachedRecords = [...shutdownLive, ...ordinary.slice(0, MAX_SESSION_RECOVERY_CANDIDATES)]
      .sort(compareCandidateRecords);
    return this.cachedRecords;
  }
}

let candidateServiceInstance: SessionRecoveryCandidateService | null = null;

export function initializeSessionRecoveryCandidateService(
  deps: SessionRecoveryCandidateDependencies,
): SessionRecoveryCandidateService {
  candidateServiceInstance = new SessionRecoveryCandidateService(deps);
  return candidateServiceInstance;
}

export function getSessionRecoveryCandidateServiceIfInitialized(): SessionRecoveryCandidateService | null {
  return candidateServiceInstance;
}

export function _resetSessionRecoveryCandidateServiceForTesting(): void {
  candidateServiceInstance = null;
}

interface InstanceLifecycleEvents {
  on(event: 'instance:created' | 'instance:removed', listener: () => void): unknown;
  removeListener(event: 'instance:created' | 'instance:removed', listener: () => void): unknown;
}

export function wireSessionRecoveryCandidateInvalidation(
  service: SessionRecoveryCandidateService,
  lifecycle: InstanceLifecycleEvents,
): () => void {
  const invalidate = (): void => service.invalidate();
  lifecycle.on('instance:created', invalidate);
  lifecycle.on('instance:removed', invalidate);
  return () => {
    lifecycle.removeListener('instance:created', invalidate);
    lifecycle.removeListener('instance:removed', invalidate);
  };
}
