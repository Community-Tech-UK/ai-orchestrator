import { createHash } from 'crypto';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { RecoveryHistoryIdentity } from '../session/session-recovery-candidate-service';

const MEANINGFUL_MESSAGE_TYPES = new Set<OutputMessage['type']>([
  'assistant',
  'user',
  'tool_use',
  'tool_result',
  'error',
]);

export interface ArchiveHistoryCoverage {
  recoveryKey?: string;
  provider?: Instance['provider'];
  historyThreadId?: string;
  sessionId?: string;
  coveredThrough?: number;
  messageCount?: number;
  historyEntryId?: string;
}

export interface ArchiveInstanceSummary {
  instanceId: string;
  status: Instance['status'];
  provider: Instance['provider'];
  historyThreadId?: string;
  providerSessionId?: string;
  sessionId?: string;
  supersededBy?: string;
  outputMessageCount: number;
  /** User and assistant messages: what makes a transcript a conversation. */
  conversationMessageCount: number;
  lastMeaningfulMessageAt?: number;
  metadata?: Record<string, unknown>;
}

export type ArchiveInstanceDecisionReason =
  | 'covered-superseded-or-hibernated'
  | 'current-generation'
  | 'coverage-unknown'
  | 'coverage-identity-mismatch'
  | 'not-covered'
  | 'automation-needs-visibility'
  | 'no-meaningful-message'
  | 'empty-transcript-over-history';

/** What `HistoryManager.archiveInstance` did with an instance it was handed. */
export type ArchiveInstanceOutcome = 'archived' | 'already-archived' | 'covered';

export interface ArchiveInstanceOptions {
  /**
   * Re-archive even though History already holds an entry from this runtime.
   * Only for a transcript built on that entry as read moments earlier (startup
   * autosave recovery). Nothing here re-checks it: the caller is responsible.
   */
  allowSameInstanceRearchive?: boolean;
}

export interface ArchiveInstanceDecision {
  shouldArchive: boolean;
  reason: ArchiveInstanceDecisionReason;
  logData: Record<string, unknown>;
}

export function createArchiveInstanceSummary(instance: Pick<
  Instance,
  | 'id'
  | 'status'
  | 'provider'
  | 'historyThreadId'
  | 'providerSessionId'
  | 'sessionId'
  | 'supersededBy'
  | 'outputBuffer'
  | 'metadata'
>): ArchiveInstanceSummary {
  const lastMeaningfulMessageAt = instance.outputBuffer.reduce<number | undefined>(
    (latest, message) => {
      if (!MEANINGFUL_MESSAGE_TYPES.has(message.type)) return latest;
      if (!Number.isFinite(message.timestamp)) return latest;
      return latest === undefined ? message.timestamp : Math.max(latest, message.timestamp);
    },
    undefined,
  );

  return {
    instanceId: instance.id,
    status: instance.status,
    provider: instance.provider,
    historyThreadId: instance.historyThreadId,
    providerSessionId: instance.providerSessionId,
    sessionId: instance.sessionId,
    supersededBy: instance.supersededBy,
    outputMessageCount: instance.outputBuffer.length,
    conversationMessageCount: instance.outputBuffer.filter(
      (message) => message.type === 'user' || message.type === 'assistant',
    ).length,
    lastMeaningfulMessageAt,
    metadata: instance.metadata,
  };
}

export function getArchiveHistoryIdentity(
  summary: ArchiveInstanceSummary,
): RecoveryHistoryIdentity | undefined {
  if (!summary.provider || summary.provider === 'auto') {
    return undefined;
  }

  const historyThreadId = normalizeId(summary.historyThreadId);
  const sessionId = normalizeId(summary.providerSessionId) ?? normalizeId(summary.sessionId);
  if (historyThreadId) {
    return {
      recoveryKey: `history:${summary.provider}:${historyThreadId}`,
      provider: summary.provider,
      historyThreadId,
      sessionId,
    };
  }
  if (sessionId) {
    return {
      recoveryKey: `session:${summary.provider}:${sessionId}`,
      provider: summary.provider,
      sessionId,
    };
  }
  return undefined;
}

export function shouldArchiveInstance(
  summary: ArchiveInstanceSummary,
  historyCoverage?: ArchiveHistoryCoverage,
): ArchiveInstanceDecision {
  // Archiving replaces every entry on the thread. A generation that holds no
  // conversation (a native-resume attempt whose CLI died at startup is emptied
  // and terminated by the restore coordinator) would otherwise overwrite the
  // saved transcript with nothing (2026-10-22: a 320-message entry rewritten
  // as empty after a Copilot CLI update broke every spawn).
  if (
    summary.conversationMessageCount === 0
    && (historyCoverage?.messageCount ?? 0) > 0
    && coverageMatchesSummary(summary, historyCoverage!)
  ) {
    return {
      shouldArchive: false,
      reason: 'empty-transcript-over-history',
      logData: createArchiveDecisionLogData('empty-transcript-over-history', summary, historyCoverage),
    };
  }
  if (!isSkippableGeneration(summary)) {
    return archive('current-generation', summary, historyCoverage);
  }
  if (hiddenAutomationNeedsVisibility(summary)) {
    return archive('automation-needs-visibility', summary, historyCoverage);
  }
  if (summary.lastMeaningfulMessageAt === undefined) {
    return archive('no-meaningful-message', summary, historyCoverage);
  }
  if (!historyCoverage || !Number.isFinite(historyCoverage.coveredThrough)) {
    return archive('coverage-unknown', summary, historyCoverage);
  }
  if (!coverageMatchesSummary(summary, historyCoverage)) {
    return archive('coverage-identity-mismatch', summary, historyCoverage);
  }
  if (
    historyCoverage.coveredThrough! >= summary.lastMeaningfulMessageAt
    && Number.isFinite(historyCoverage.messageCount)
    && historyCoverage.messageCount! >= summary.outputMessageCount
  ) {
    return {
      shouldArchive: false,
      reason: 'covered-superseded-or-hibernated',
      logData: createArchiveDecisionLogData(
        'covered-superseded-or-hibernated',
        summary,
        historyCoverage,
      ),
    };
  }

  return archive('not-covered', summary, historyCoverage);
}

function archive(
  reason: ArchiveInstanceDecisionReason,
  summary: ArchiveInstanceSummary,
  historyCoverage?: ArchiveHistoryCoverage,
): ArchiveInstanceDecision {
  return {
    shouldArchive: true,
    reason,
    logData: createArchiveDecisionLogData(reason, summary, historyCoverage),
  };
}

function normalizeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isSkippableGeneration(summary: ArchiveInstanceSummary): boolean {
  return summary.status === 'hibernated'
    || summary.status === 'superseded';
}

function hiddenAutomationNeedsVisibility(summary: ArchiveInstanceSummary): boolean {
  return Boolean(
    summary.metadata?.['automationId']
    && summary.metadata?.['automationHidden'] === true
    && (summary.metadata?.['automationRunSucceeded'] !== true
      || summary.metadata?.['automationRevealed'] === true),
  );
}

function coverageMatchesSummary(
  summary: ArchiveInstanceSummary,
  coverage: ArchiveHistoryCoverage,
): boolean {
  if (coverage.provider && coverage.provider !== summary.provider) {
    return false;
  }

  const summaryHistoryThreadId = normalizeId(summary.historyThreadId);
  const coverageHistoryThreadId = normalizeId(coverage.historyThreadId);
  if (summaryHistoryThreadId) {
    return summaryHistoryThreadId === coverageHistoryThreadId;
  }

  const coverageSessionId = normalizeId(coverage.sessionId);
  if (!coverageSessionId) {
    return false;
  }
  return [
    normalizeId(summary.providerSessionId),
    normalizeId(summary.sessionId),
  ].includes(coverageSessionId);
}

function createArchiveDecisionLogData(
  reason: ArchiveInstanceDecisionReason,
  summary: ArchiveInstanceSummary,
  coverage?: ArchiveHistoryCoverage,
): Record<string, unknown> {
  return {
    reason,
    provider: summary.provider,
    status: summary.status,
    instanceId: redactArchiveIdentifier(summary.instanceId),
    historyThreadId: redactArchiveIdentifier(summary.historyThreadId),
    providerSessionId: redactArchiveIdentifier(summary.providerSessionId),
    sessionId: redactArchiveIdentifier(summary.sessionId),
    historyEntryId: redactArchiveIdentifier(coverage?.historyEntryId),
    coveredThrough: coverage?.coveredThrough,
    historyMessageCount: coverage?.messageCount,
    lastMeaningfulMessageAt: summary.lastMeaningfulMessageAt,
    outputMessageCount: summary.outputMessageCount,
    conversationMessageCount: summary.conversationMessageCount,
  };
}

export function redactArchiveIdentifier(value: string | undefined): string | undefined {
  const normalized = normalizeId(value);
  if (!normalized) return undefined;
  return `sha256:${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}
