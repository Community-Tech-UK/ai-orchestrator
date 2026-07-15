import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';

type Handler = (event: unknown, payload: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  },
}));

describe('registerContextEvidenceHandlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it('registers every request channel', async () => {
    const h = await harness();

    expect([...handlers.keys()]).toEqual(expect.arrayContaining([
      IPC_CHANNELS.CONTEXT_EVIDENCE_LIST,
      IPC_CHANNELS.CONTEXT_EVIDENCE_GET_CARD,
      IPC_CHANNELS.CONTEXT_EVIDENCE_SEARCH,
      IPC_CHANNELS.CONTEXT_EVIDENCE_READ,
      IPC_CHANNELS.CONTEXT_EVIDENCE_COMPARE,
      IPC_CHANNELS.CONTEXT_EVIDENCE_VERIFY,
      IPC_CHANNELS.CONTEXT_EVIDENCE_GET_METRICS,
    ]));
    h.cleanup();
  });

  it('rejects missing ownership, renderer provider IDs, and cross-conversation claims', async () => {
    const h = await harness();

    expect((await invoke(IPC_CHANNELS.CONTEXT_EVIDENCE_LIST, {
      owner: { kind: 'chat', chatId: 'chat-1' },
    })).error?.code).toBe('VALIDATION_FAILED');
    expect((await invoke(IPC_CHANNELS.CONTEXT_EVIDENCE_LIST, {
      ...chatScope(), provider: 'renderer-controlled',
    })).error?.code).toBe('VALIDATION_FAILED');
    const denied = await invoke(IPC_CHANNELS.CONTEXT_EVIDENCE_LIST, {
      ...chatScope(), conversationId: 'other-conversation',
    });
    expect(denied).toMatchObject({
      success: false,
      error: { message: 'CONTEXT_EVIDENCE_SCOPE_DENIED' },
    });
    expect(h.coordinator.list).not.toHaveBeenCalled();
    h.cleanup();
  });

  it('derives trusted chat and instance scope and reuses every coordinator retrieval operation', async () => {
    const h = await harness();

    await invoke(IPC_CHANNELS.CONTEXT_EVIDENCE_LIST, { ...chatScope(), limit: 25 });
    await invoke(IPC_CHANNELS.CONTEXT_EVIDENCE_GET_CARD, {
      ...chatScope(), cardId: 'card-1', tokenLimit: 512,
    });
    await invoke(IPC_CHANNELS.CONTEXT_EVIDENCE_SEARCH, {
      ...instanceScope(), query: 'needle', tokenLimit: 512,
    });
    await invoke(IPC_CHANNELS.CONTEXT_EVIDENCE_READ, {
      ...instanceScope(), evidenceId: 'evidence-1', startByte: 0, endByte: 7,
      tokenLimit: 512,
    });
    await invoke(IPC_CHANNELS.CONTEXT_EVIDENCE_COMPARE, {
      ...instanceScope(),
      left: { evidenceId: 'evidence-1', startByte: 0, endByte: 2 },
      right: { evidenceId: 'evidence-2', startByte: 2, endByte: 4 },
    });
    await invoke(IPC_CHANNELS.CONTEXT_EVIDENCE_VERIFY, {
      ...instanceScope(), evidenceId: 'evidence-1', startByte: 0, endByte: 7,
      contentDigest: 'd'.repeat(64),
    });

    expect(h.coordinator.list).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      requester: expect.objectContaining({ path: 'ipc' }),
    }));
    expect(h.coordinator.getCard).toHaveBeenCalledWith(expect.objectContaining({
      cardId: 'card-1', tokenLimit: 512, providerWindowTokens: 100_000,
    }));
    for (const method of ['search', 'read', 'compare', 'verify'] as const) {
      expect(h.coordinator[method]).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: 'conversation-1',
        providerWindowTokens: 100_000,
      }));
    }
    h.cleanup();
  });

  it('returns separated canonical metrics without treating cumulative input as occupancy', async () => {
    const h = await harness();
    const response = await invoke(IPC_CHANNELS.CONTEXT_EVIDENCE_GET_METRICS, instanceScope());

    expect(response).toEqual({
      success: true,
      data: {
        occupancy: { status: 'known', used: 60_000, total: 100_000 },
        cumulativeTokens: 400_000,
        workingSet: allocation(),
        evidenceRecordCount: 8,
        evidenceCardCount: 6,
        exactExcerptCount: 0,
        externallyStoredBytes: 900_532,
        modelRequestCount: 44,
        toolCallCount: 44,
        toolResultBytes: 900_000,
        enforcementMode: 'shadow',
        lastAction: 'native-compaction',
        recoveryCount: 2,
        updatedAt: 500,
      },
    });
    h.cleanup();
  });

  it('pushes scoped state changes and removes coordinator and instance listeners on cleanup', async () => {
    const h = await harness();
    h.emitCoordinator({ kind: 'metrics-updated', conversationId: 'conversation-1' });
    await vi.waitFor(() => expect(h.sendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.CONTEXT_EVIDENCE_STATE_CHANGED,
      expect.objectContaining({ conversationId: 'conversation-1' }),
    ));

    h.cleanup();
    expect(h.unsubscribeCoordinator).toHaveBeenCalledOnce();
    expect(h.instanceManager.listenerCount('instance:state-changed')).toBe(0);
  });
});

async function harness() {
  const coordinatorListener = { current: null as ((event: unknown) => void) | null };
  const unsubscribeCoordinator = vi.fn();
  const coordinator = {
    list: vi.fn(async () => []),
    getCard: vi.fn(async () => ({ card: { id: 'card-1' } })),
    search: vi.fn(async () => []),
    read: vi.fn(async () => ({ evidenceId: 'evidence-1' })),
    compare: vi.fn(async () => ({ equal: false })),
    verify: vi.fn(async () => ({ verified: true })),
    assembleWorkingSet: vi.fn(() => ({ plan: { allocation: allocation() }, rendered: null })),
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      coordinatorListener.current = listener;
      return unsubscribeCoordinator;
    }),
  };
  const instance = {
    id: 'instance-1', requestCount: 44,
    contextUsage: {
      used: 60_000, total: 100_000, percentage: 60, cumulativeTokens: 400_000,
    },
    contextEvidence: {
      mode: 'shadow', conversationId: 'conversation-1', captureFailureCount: 0,
    },
  };
  const instanceManager = Object.assign(new EventEmitter(), {
    getInstance: vi.fn((id: string) => id === 'instance-1' ? instance : undefined),
    getAllInstances: vi.fn(() => [instance]),
  });
  const sendToRenderer = vi.fn();
  const { registerContextEvidenceHandlers } = await import('./context-evidence.handlers');
  const cleanup = registerContextEvidenceHandlers({
    instanceManager: instanceManager as never,
    windowManager: { sendToRenderer } as never,
    coordinator: coordinator as never,
    ledger: {
      getContextEvidenceConversationMetrics: vi.fn(async () => ({
        evidenceRecordCount: 8, evidenceCardCount: 6, externallyStoredBytes: 900_532,
        toolCallCount: 44, toolResultBytes: 900_000,
        lastActionCode: 'native-compaction', recoveryCount: 2,
      })),
    } as never,
    getChats: () => [{
      id: 'chat-1', ledgerThreadId: 'conversation-1', currentInstanceId: 'instance-1',
    } as never],
    now: () => 500,
  });
  return {
    cleanup, coordinator, instanceManager, sendToRenderer, unsubscribeCoordinator,
    emitCoordinator: (event: unknown) => coordinatorListener.current?.(event),
  };
}

function chatScope() {
  return { conversationId: 'conversation-1', owner: { kind: 'chat', chatId: 'chat-1' } };
}

function instanceScope() {
  return {
    conversationId: 'conversation-1',
    owner: { kind: 'instance', instanceId: 'instance-1' },
  };
}

function allocation() {
  return {
    capacityTokens: 100_000,
    instructionsTokens: 15_000,
    recentDialogueTokens: 15_000,
    evidenceCardTokens: 15_000,
    exactExcerptTokens: 15_000,
    reasoningAndAnswerTokens: 25_000,
    emergencyReserveTokens: 15_000,
    normalWorkingSetTokens: 60_000,
    totalAllocatedTokens: 100_000,
    estimateKind: 'provider-tokenizer' as const,
  };
}

async function invoke(channel: string, payload: unknown): Promise<IpcResponse> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler ${channel}`);
  return handler({}, payload);
}
