import type { ChatRecord } from '../../shared/types/chat.types';
import type {
  EvidenceConversationOwnerReference,
  Instance,
} from '../../shared/types/instance.types';
import type {
  ConversationThreadRecord,
} from '../../shared/types/conversation-ledger.types';
import type { AppSettings, ContextEvidenceMode } from '../../shared/types/settings.types';
import { getContextEvidenceMode } from './context-evidence-settings';

export type EvidenceConversationOwnershipSource = 'chat-ledger' | 'instance-history';
export type EvidenceOwnershipFailureDisposition =
  | 'preserve-provider-output'
  | 'pause-before-destructive-action';

export interface EvidenceConversationOwner {
  id: string;
  historyThreadId?: string;
  provider?: string;
  providerSessionId?: string;
  sessionId?: string;
  workingDirectory?: string;
  evidenceConversationOwner?: EvidenceConversationOwnerReference;
}

export interface EvidenceConversationLedger {
  getThread(id: string): Promise<ConversationThreadRecord | null>;
  listConversations(query?: {
    provider?: 'orchestrator';
    sourceKind?: 'orchestrator';
    limit?: number;
  }): Promise<ConversationThreadRecord[]>;
  startConversation(input: {
    provider: 'orchestrator';
    workspacePath?: string;
    title?: string;
    metadata: Record<string, unknown>;
  }): Promise<ConversationThreadRecord>;
}

export interface EvidenceConversationChatStore {
  getByInstanceId(instanceId: string): ChatRecord | null;
}

export interface EvidenceCaptureFailureMetric {
  name: 'context_evidence_capture_failure';
  reason: 'unresolved-conversation-ownership';
  increment: 1;
}

export type EvidenceConversationResolution =
  | {
      status: 'resolved';
      mode: ContextEvidenceMode;
      conversationId: string;
      source: EvidenceConversationOwnershipSource;
    }
  | {
      status: 'unresolved';
      mode: ContextEvidenceMode;
      reason:
        | 'chat-ledger-thread-missing'
        | 'chat-ledger-thread-not-aio-owned'
        | 'history-thread-id-missing'
        | 'history-thread-unavailable';
      disposition: EvidenceOwnershipFailureDisposition;
      metric: EvidenceCaptureFailureMetric;
    };

export interface EvidenceConversationResolverConfig {
  ledger: EvidenceConversationLedger;
  chatStore?: EvidenceConversationChatStore;
}

interface EvidenceConversationResolverLike {
  resolve(
    instance: Instance,
    options: { mode: ContextEvidenceMode },
  ): Promise<EvidenceConversationResolution>;
}

const CAPTURE_FAILURE_METRIC: EvidenceCaptureFailureMetric = Object.freeze({
  name: 'context_evidence_capture_failure',
  reason: 'unresolved-conversation-ownership',
  increment: 1,
});

const standaloneResolutionQueues = new WeakMap<
  EvidenceConversationLedger,
  Map<string, Promise<void>>
>();

/** Resolves AIO-owned conversation identity without consulting provider IDs. */
export class EvidenceConversationResolver {
  private readonly ledger: EvidenceConversationLedger;
  private readonly chatStore?: EvidenceConversationChatStore;

  constructor(config: EvidenceConversationResolverConfig) {
    this.ledger = config.ledger;
    this.chatStore = config.chatStore;
  }

  async resolve(
    owner: EvidenceConversationOwner,
    options: { mode: ContextEvidenceMode },
  ): Promise<EvidenceConversationResolution> {
    const chat = this.chatStore?.getByInstanceId(owner.id) ?? null;
    if (chat) {
      return this.resolveChat(chat, options.mode);
    }
    if (owner.evidenceConversationOwner?.kind === 'chat') {
      return this.resolveAnchoredChat(owner.evidenceConversationOwner, options.mode);
    }
    return this.resolveStandalone(owner, options.mode);
  }

  private async resolveAnchoredChat(
    anchor: EvidenceConversationOwnerReference,
    mode: ContextEvidenceMode,
  ): Promise<EvidenceConversationResolution> {
    const row = await this.ledger.getThread(anchor.conversationId);
    if (!row) {
      return unresolved(mode, 'chat-ledger-thread-missing');
    }
    if (
      !isAioOwnedConversation(row)
      || row.metadata['scope'] !== 'chat'
      || row.metadata['chatId'] !== anchor.chatId
    ) {
      return unresolved(mode, 'chat-ledger-thread-not-aio-owned');
    }
    return {
      status: 'resolved',
      mode,
      conversationId: row.id,
      source: 'chat-ledger',
    };
  }

  private async resolveChat(
    chat: ChatRecord,
    mode: ContextEvidenceMode,
  ): Promise<EvidenceConversationResolution> {
    const row = await this.ledger.getThread(chat.ledgerThreadId);
    if (!row) {
      return unresolved(mode, 'chat-ledger-thread-missing');
    }
    if (!isAioOwnedConversation(row)) {
      return unresolved(mode, 'chat-ledger-thread-not-aio-owned');
    }
    return {
      status: 'resolved',
      mode,
      conversationId: row.id,
      source: 'chat-ledger',
    };
  }

  private async resolveStandalone(
    owner: EvidenceConversationOwner,
    mode: ContextEvidenceMode,
  ): Promise<EvidenceConversationResolution> {
    const historyThreadId = owner.historyThreadId?.trim();
    if (!historyThreadId) {
      return unresolved(mode, 'history-thread-id-missing');
    }

    return withStandaloneResolutionLock(this.ledger, historyThreadId, () =>
      this.resolveStandaloneLocked(owner, historyThreadId, mode));
  }

  private async resolveStandaloneLocked(
    owner: EvidenceConversationOwner,
    historyThreadId: string,
    mode: ContextEvidenceMode,
  ): Promise<EvidenceConversationResolution> {
    const direct = await this.ledger.getThread(historyThreadId);
    if (direct && isMatchingInstanceConversation(direct, historyThreadId)) {
      return {
        status: 'resolved',
        mode,
        conversationId: direct.id,
        source: 'instance-history',
      };
    }

    const candidates = await this.ledger.listConversations({
      provider: 'orchestrator',
      sourceKind: 'orchestrator',
      limit: 5_000,
    });
    const existing = candidates.find((candidate) =>
      isMatchingInstanceConversation(candidate, historyThreadId));
    if (existing) {
      return {
        status: 'resolved',
        mode,
        conversationId: existing.id,
        source: 'instance-history',
      };
    }

    try {
      const created = await this.ledger.startConversation({
        provider: 'orchestrator',
        workspacePath: owner.workingDirectory,
        title: `Instance ${owner.id}`,
        metadata: {
          scope: 'instance',
          operatorThreadKind: 'instance',
          historyThreadId,
        },
      });
      if (!isAioOwnedConversation(created)) {
        return unresolved(mode, 'history-thread-unavailable');
      }
      return {
        status: 'resolved',
        mode,
        conversationId: created.id,
        source: 'instance-history',
      };
    } catch {
      return unresolved(mode, 'history-thread-unavailable');
    }
  }
}

/**
 * Establish canonical AIO ownership before an enabled provider can capture.
 * Default-off providers stay inert. An unresolved shadow owner is observable
 * but pass-through; enforce records the pause disposition consumed by the
 * destructive-action/completion gates added later in the rollout.
 */
export async function initializeInstanceEvidenceOwnership(
  instance: Instance,
  settings: Pick<AppSettings, 'contextEvidenceModeByProvider'>,
  injectedResolver?: EvidenceConversationResolverLike,
): Promise<void> {
  const mode = getContextEvidenceMode(
    settings.contextEvidenceModeByProvider,
    instance.provider,
  );
  const priorFailureCount = instance.contextEvidence?.captureFailureCount ?? 0;
  if (mode === 'off') {
    instance.contextEvidence = { mode, captureFailureCount: priorFailureCount };
    return;
  }

  const resolver = injectedResolver ?? new EvidenceConversationResolver({
    ledger: (await import('../conversation-ledger')).getConversationLedgerService(),
  });
  const resolution = await resolver.resolve(instance, { mode });
  if (resolution.status === 'resolved') {
    instance.contextEvidence = {
      mode,
      conversationId: resolution.conversationId,
      ownershipSource: resolution.source,
      captureFailureCount: priorFailureCount,
    };
    return;
  }

  instance.contextEvidence = {
    mode,
    captureFailureCount: priorFailureCount + resolution.metric.increment,
    lastCaptureFailure: {
      code: resolution.metric.reason,
      reason: resolution.reason,
      disposition: resolution.disposition,
      occurredAt: Date.now(),
    },
  };
}

/** Provider-native identity is capture provenance only, never authorization. */
export function getEvidenceProviderProvenance(owner: EvidenceConversationOwner): {
  provider: string;
  providerThreadRef?: string;
} {
  const providerThreadRef = owner.providerSessionId?.trim() || owner.sessionId?.trim();
  return {
    provider: owner.provider?.trim() || 'unknown',
    ...(providerThreadRef ? { providerThreadRef } : {}),
  };
}

function isAioOwnedConversation(row: ConversationThreadRecord): boolean {
  return row.provider === 'orchestrator' && row.sourceKind === 'orchestrator';
}

function isMatchingInstanceConversation(
  row: ConversationThreadRecord,
  historyThreadId: string,
): boolean {
  return isAioOwnedConversation(row)
    && row.metadata['scope'] === 'instance'
    && row.metadata['historyThreadId'] === historyThreadId;
}

async function withStandaloneResolutionLock<T>(
  ledger: EvidenceConversationLedger,
  historyThreadId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queue = standaloneResolutionQueues.get(ledger);
  if (!queue) {
    queue = new Map<string, Promise<void>>();
    standaloneResolutionQueues.set(ledger, queue);
  }

  const previous = queue.get(historyThreadId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.set(historyThreadId, current);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (queue.get(historyThreadId) === current) {
      queue.delete(historyThreadId);
    }
  }
}

function unresolved(
  mode: ContextEvidenceMode,
  reason: Extract<EvidenceConversationResolution, { status: 'unresolved' }>['reason'],
): EvidenceConversationResolution {
  return {
    status: 'unresolved',
    mode,
    reason,
    disposition: mode === 'enforce'
      ? 'pause-before-destructive-action'
      : 'preserve-provider-output',
    metric: CAPTURE_FAILURE_METRIC,
  };
}
