import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  ContextEvidenceCompareRequestSchema,
  ContextEvidenceGetCardRequestSchema,
  ContextEvidenceGetMetricsRequestSchema,
  ContextEvidenceListRequestSchema,
  ContextEvidenceReadRequestSchema,
  ContextEvidenceSearchRequestSchema,
  ContextEvidenceVerifyRequestSchema,
} from '@contracts/schemas/context-evidence';
import type {
  ContextEvidenceOwner,
  ContextEvidenceRendererMetrics,
  ContextEvidenceScope,
  EnforcementActionKind,
  EvidenceRecord,
} from '@contracts/types/context-evidence';
import type { ChatRecord } from '../../../shared/types/chat.types';
import type { Instance } from '../../../shared/types/instance.types';
import { getChatService } from '../../chats';
import {
  getContextEvidenceCoordinator,
  type ContextEvidenceCoordinator,
  type ContextEvidenceCoordinatorEvent,
} from '../../context-evidence/context-evidence-coordinator';
import {
  getConversationLedgerService,
  type ConversationLedgerService,
} from '../../conversation-ledger';
import type { EvidenceLedgerRecord } from '../../conversation-ledger/context-evidence-ledger.types';
import type {
  InstanceManager,
  InstanceStateChangedEvent,
} from '../../instance/instance-manager';
import { getLogger } from '../../logging/logger';
import { registerCleanup } from '../../util/cleanup-registry';
import type { WindowManager } from '../../window-manager';
import { validatedHandler, type IpcResponse } from '../validated-handler';

const logger = getLogger('ContextEvidenceHandlers');

const ENFORCEMENT_ACTIONS = new Set<EnforcementActionKind>([
  'none',
  'externalize-result',
  'rebuild-working-set',
  'native-compaction',
  'stop-broad-research',
  'controlled-interrupt',
  'controlled-recovery',
  'same-thread-continuation',
  'convergence-review',
  'pause',
]);

interface ContextEvidenceHandlerDependencies {
  instanceManager: Pick<InstanceManager, 'getInstance' | 'getAllInstances' | 'on' | 'off'>;
  windowManager: Pick<WindowManager, 'sendToRenderer'>;
  coordinator?: ContextEvidenceCoordinator;
  ledger?: Pick<ConversationLedgerService, 'getContextEvidenceConversationMetrics'>;
  getChats?: () => ChatRecord[];
  now?: () => number;
}

interface AuthorizedScope {
  conversationId: string;
  instance?: Instance;
}

let activeCleanup: (() => void) | null = null;

/** Registers conversation-owned, bounded context-evidence renderer surfaces. */
export function registerContextEvidenceHandlers(
  dependencies: ContextEvidenceHandlerDependencies,
): () => void {
  activeCleanup?.();
  const coordinator = dependencies.coordinator ?? getContextEvidenceCoordinator();
  const ledger = dependencies.ledger ?? getConversationLedgerService();
  const getChats = dependencies.getChats
    ?? (() => getChatService({ instanceManager: dependencies.instanceManager as InstanceManager })
      .listChats({ includeArchived: true }));
  const now = dependencies.now ?? Date.now;

  const authorize = (scope: ContextEvidenceScope): AuthorizedScope => {
    return authorizeScope(scope, dependencies.instanceManager, getChats);
  };
  const retrievalInput = (scope: ContextEvidenceScope, operation: string) => {
    const authorized = authorize(scope);
    return {
      authorized,
      shared: {
        conversationId: authorized.conversationId,
        requester: {
          id: `ipc:${operation}:${scope.owner.kind}`,
          path: 'ipc' as const,
          localSensitiveAuthorized: true,
          localRestrictedAuthorized: true,
        },
        ...providerWindow(authorized.instance),
      },
    };
  };

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_EVIDENCE_LIST,
    validatedHandler(
      IPC_CHANNELS.CONTEXT_EVIDENCE_LIST,
      ContextEvidenceListRequestSchema,
      async (request): Promise<IpcResponse<EvidenceRecord[]>> => {
        const { shared } = retrievalInput(request, 'list');
        const records = await coordinator.list({
          ...shared,
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        });
        return { success: true, data: records.map(toEvidenceRecord) };
      },
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_EVIDENCE_GET_CARD,
    validatedHandler(
      IPC_CHANNELS.CONTEXT_EVIDENCE_GET_CARD,
      ContextEvidenceGetCardRequestSchema,
      async (request) => {
        const { shared } = retrievalInput(request, 'get-card');
        return {
          success: true,
          data: await coordinator.getCard({
            ...shared,
            cardId: request.cardId,
            tokenLimit: request.tokenLimit,
          }),
        };
      },
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_EVIDENCE_SEARCH,
    validatedHandler(
      IPC_CHANNELS.CONTEXT_EVIDENCE_SEARCH,
      ContextEvidenceSearchRequestSchema,
      async (request) => {
        const { shared } = retrievalInput(request, 'search');
        return {
          success: true,
          data: await coordinator.search({
            ...shared,
            query: request.query,
            tokenLimit: request.tokenLimit,
          }),
        };
      },
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_EVIDENCE_READ,
    validatedHandler(
      IPC_CHANNELS.CONTEXT_EVIDENCE_READ,
      ContextEvidenceReadRequestSchema,
      async (request) => {
        const { shared } = retrievalInput(request, 'read');
        return {
          success: true,
          data: await coordinator.read({
            ...shared,
            evidenceId: request.evidenceId,
            startByte: request.startByte,
            endByte: request.endByte,
            tokenLimit: request.tokenLimit,
          }),
        };
      },
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_EVIDENCE_COMPARE,
    validatedHandler(
      IPC_CHANNELS.CONTEXT_EVIDENCE_COMPARE,
      ContextEvidenceCompareRequestSchema,
      async (request) => {
        const { shared } = retrievalInput(request, 'compare');
        return {
          success: true,
          data: await coordinator.compare({
            ...shared,
            left: request.left,
            right: request.right,
          }),
        };
      },
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_EVIDENCE_VERIFY,
    validatedHandler(
      IPC_CHANNELS.CONTEXT_EVIDENCE_VERIFY,
      ContextEvidenceVerifyRequestSchema,
      async (request) => {
        const { shared } = retrievalInput(request, 'verify');
        return {
          success: true,
          data: await coordinator.verify({
            ...shared,
            evidenceId: request.evidenceId,
            startByte: request.startByte,
            endByte: request.endByte,
            contentDigest: request.contentDigest,
          }),
        };
      },
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_EVIDENCE_GET_METRICS,
    validatedHandler(
      IPC_CHANNELS.CONTEXT_EVIDENCE_GET_METRICS,
      ContextEvidenceGetMetricsRequestSchema,
      async (request): Promise<IpcResponse<ContextEvidenceRendererMetrics>> => {
        const authorized = authorize(request);
        return {
          success: true,
          data: await buildMetrics({
            conversationId: authorized.conversationId,
            instance: authorized.instance,
            coordinator,
            ledger,
            now,
          }),
        };
      },
    ),
  );

  let acceptingEvents = true;
  const pushMetrics = async (conversationId: string, preferredInstance?: Instance): Promise<void> => {
    if (!acceptingEvents) return;
    const instance = preferredInstance ?? dependencies.instanceManager.getAllInstances()
      .find((candidate) => candidate.contextEvidence?.conversationId === conversationId);
    const metrics = await buildMetrics({ conversationId, instance, coordinator, ledger, now });
    if (!acceptingEvents) return;
    dependencies.windowManager.sendToRenderer(IPC_CHANNELS.CONTEXT_EVIDENCE_STATE_CHANGED, {
      conversationId,
      metrics,
    });
  };
  const queuePush = (conversationId: string, instance?: Instance): void => {
    void pushMetrics(conversationId, instance).catch(() => {
      logger.warn('Context-evidence state push failed', { failureCode: 'metrics-unavailable' });
    });
  };
  const unsubscribeCoordinator = coordinator.subscribe((event: ContextEvidenceCoordinatorEvent) => {
    queuePush(
      event.conversationId,
      event.queueId ? dependencies.instanceManager.getInstance(event.queueId) : undefined,
    );
  });
  const onInstanceStateChanged = (event: InstanceStateChangedEvent): void => {
    const instance = event.instance ?? dependencies.instanceManager.getInstance(event.instanceId);
    const conversationId = instance?.contextEvidence?.conversationId;
    if (conversationId) queuePush(conversationId, instance);
  };
  dependencies.instanceManager.on('instance:state-changed', onInstanceStateChanged);

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    acceptingEvents = false;
    if (activeCleanup === cleanup) activeCleanup = null;
    unsubscribeCoordinator();
    dependencies.instanceManager.off('instance:state-changed', onInstanceStateChanged);
    for (const channel of requestChannels()) {
      if ('removeHandler' in ipcMain && typeof ipcMain.removeHandler === 'function') {
        ipcMain.removeHandler(channel);
      }
    }
  };
  activeCleanup = cleanup;
  registerCleanup(cleanup);
  return cleanup;
}

function authorizeScope(
  scope: ContextEvidenceScope,
  instanceManager: Pick<InstanceManager, 'getInstance' | 'getAllInstances'>,
  getChats: () => ChatRecord[],
): AuthorizedScope {
  const expected = expectedConversation(scope.owner, instanceManager, getChats);
  if (!expected || expected.conversationId !== scope.conversationId) {
    throw new Error('CONTEXT_EVIDENCE_SCOPE_DENIED');
  }
  return expected;
}

function expectedConversation(
  owner: ContextEvidenceOwner,
  instanceManager: Pick<InstanceManager, 'getInstance' | 'getAllInstances'>,
  getChats: () => ChatRecord[],
): AuthorizedScope | null {
  if (owner.kind === 'instance') {
    const instance = instanceManager.getInstance(owner.instanceId);
    const conversationId = instance?.contextEvidence?.conversationId;
    return instance && conversationId ? { conversationId, instance } : null;
  }
  const chat = getChats().find((candidate) => candidate.id === owner.chatId);
  if (!chat?.ledgerThreadId) return null;
  const instance = chat.currentInstanceId
    ? instanceManager.getInstance(chat.currentInstanceId)
    : undefined;
  return { conversationId: chat.ledgerThreadId, ...(instance ? { instance } : {}) };
}

function providerWindow(instance: Instance | undefined): { providerWindowTokens?: number } {
  const total = instance?.contextUsage?.total;
  return Number.isSafeInteger(total) && total !== undefined && total > 0
    ? { providerWindowTokens: total }
    : {};
}

function toEvidenceRecord(record: EvidenceLedgerRecord): EvidenceRecord {
  return {
    id: record.id,
    conversationId: record.conversationId,
    provider: record.provider,
    ...(record.providerThreadRef ? { providerThreadRef: record.providerThreadRef } : {}),
    ...(record.turnRef ? { turnRef: record.turnRef } : {}),
    ...(record.toolCallRef ? { toolCallRef: record.toolCallRef } : {}),
    toolName: record.toolName,
    sourceKind: record.sourceKind,
    status: record.status,
    ...(record.keyedContentId ? { keyedContentId: record.keyedContentId } : {}),
    byteCount: record.byteCount,
    ...(record.tokenEstimate === null ? {} : { tokenEstimate: record.tokenEstimate }),
    mimeType: record.mimeType,
    sensitivity: record.sensitivity,
    provenanceTrust: record.provenanceTrust,
    createdAt: record.createdAt,
    ...(record.completedAt === null ? {} : { completedAt: record.completedAt }),
    ...(record.keyVersion === null ? {} : { keyVersion: record.keyVersion }),
    captureMode: record.captureMode,
    captureCompleteness: record.captureCompleteness,
    ...(record.truncationReason ? { truncationReason: record.truncationReason } : {}),
  };
}

async function buildMetrics(input: {
  conversationId: string;
  instance?: Instance;
  coordinator: Pick<ContextEvidenceCoordinator, 'assembleWorkingSet'>;
  ledger: Pick<ConversationLedgerService, 'getContextEvidenceConversationMetrics'>;
  now: () => number;
}): Promise<ContextEvidenceRendererMetrics> {
  const aggregate = await input.ledger.getContextEvidenceConversationMetrics(input.conversationId);
  const capacityTokens = providerWindow(input.instance).providerWindowTokens;
  const workingSet = input.coordinator.assembleWorkingSet({
    ...(capacityTokens === undefined ? {} : { capacityTokens }),
    requiredInstructions: [],
    latestUserIntent: '',
    recentDialogue: [],
    activeTaskState: [],
    evidenceCards: [],
    exactExcerpts: [],
  }).plan.allocation;
  const occupancy = currentOccupancy(input.instance);
  const cumulativeTokens = safeMetric(input.instance?.contextUsage?.cumulativeTokens);
  const lastAction = validAction(aggregate.lastActionCode);
  return {
    occupancy,
    ...(cumulativeTokens === undefined ? {} : { cumulativeTokens }),
    workingSet,
    evidenceRecordCount: aggregate.evidenceRecordCount,
    evidenceCardCount: aggregate.evidenceCardCount,
    exactExcerptCount: 0,
    externallyStoredBytes: aggregate.externallyStoredBytes,
    modelRequestCount: safeMetric(input.instance?.requestCount) ?? 0,
    toolCallCount: aggregate.toolCallCount,
    toolResultBytes: aggregate.toolResultBytes,
    enforcementMode: input.instance?.contextEvidence?.mode ?? 'off',
    ...(lastAction ? { lastAction } : {}),
    recoveryCount: aggregate.recoveryCount,
    updatedAt: input.now(),
  };
}

function currentOccupancy(instance: Instance | undefined): ContextEvidenceRendererMetrics['occupancy'] {
  const usage = instance?.contextUsage;
  if (!usage || usage.isEstimated || !Number.isSafeInteger(usage.used)
    || !Number.isSafeInteger(usage.total) || usage.used < 0 || usage.total <= 0
    || usage.used > usage.total) {
    return { status: 'unknown', reason: 'Current provider context-window occupancy is unavailable.' };
  }
  return { status: 'known', used: usage.used, total: usage.total };
}

function safeMetric(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0 ? value : undefined;
}

function validAction(value: string | null): EnforcementActionKind | undefined {
  return value && ENFORCEMENT_ACTIONS.has(value as EnforcementActionKind)
    ? value as EnforcementActionKind
    : undefined;
}

function requestChannels(): string[] {
  return [
    IPC_CHANNELS.CONTEXT_EVIDENCE_LIST,
    IPC_CHANNELS.CONTEXT_EVIDENCE_GET_CARD,
    IPC_CHANNELS.CONTEXT_EVIDENCE_SEARCH,
    IPC_CHANNELS.CONTEXT_EVIDENCE_READ,
    IPC_CHANNELS.CONTEXT_EVIDENCE_COMPARE,
    IPC_CHANNELS.CONTEXT_EVIDENCE_VERIFY,
    IPC_CHANNELS.CONTEXT_EVIDENCE_GET_METRICS,
  ];
}
