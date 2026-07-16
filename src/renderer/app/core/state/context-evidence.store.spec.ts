import type {
  ContextEvidenceRendererMetrics,
  ContextEvidenceStateChanged,
} from '@contracts/types/context-evidence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextEvidenceStore } from './context-evidence.store';

describe('ContextEvidenceStore', () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('keeps occupancy, cumulative, working-set, evidence, and tool metrics separate', async () => {
    const store = new ContextEvidenceStore();
    store.setScope(scope());
    await store.refresh();

    expect(store.occupancy()).toEqual({ status: 'known', used: 60_000, total: 100_000 });
    expect(store.cumulativeTokens()).toBe(400_000);
    expect(store.workingSet()?.normalWorkingSetTokens).toBe(60_000);
    expect(store.evidenceRecordCount()).toBe(8);
    expect(store.evidenceCardCount()).toBe(6);
    expect(store.exactExcerptCount()).toBe(2);
    expect(store.externallyStoredBytes()).toBe(900_532);
    expect(store.modelRequestCount()).toBe(44);
    expect(store.toolCallCount()).toBe(31);
    expect(store.toolResultBytes()).toBe(900_000);
    expect(store.enforcementMode()).toBe('shadow');
    expect(store.lastAction()).toBe('native-compaction');
    expect(store.recoveryCount()).toBe(2);
    expect(api.contextEvidenceList).toHaveBeenCalledWith({ ...scope(), limit: 100 });
    expect(api.contextEvidenceGetMetrics).toHaveBeenCalledWith(scope());
  });

  it('uses the selected main-owned scope for bounded card, search, and read requests', async () => {
    const store = new ContextEvidenceStore();
    store.setScope(scope());

    await store.loadCard('card-1', 512);
    await store.search('needle', 256);
    await store.read('evidence-1', 2, 8, 128);

    expect(api.contextEvidenceGetCard).toHaveBeenCalledWith({
      ...scope(), cardId: 'card-1', tokenLimit: 512,
    });
    expect(api.contextEvidenceSearch).toHaveBeenCalledWith({
      ...scope(), query: 'needle', tokenLimit: 256,
    });
    expect(api.contextEvidenceRead).toHaveBeenCalledWith({
      ...scope(), evidenceId: 'evidence-1', startByte: 2, endByte: 8, tokenLimit: 128,
    });
    expect(store.selectedCard()?.card.id).toBe('card-1');
    expect(store.searchResults()[0]?.preview).toBe('match');
    expect(store.readResult()?.content).toBe('bounded excerpt');
  });

  it('accepts only matching push updates and unsubscribes on destroy', () => {
    const store = new ContextEvidenceStore();
    store.setScope(scope());
    api.emit({ conversationId: 'other', metrics: { ...metrics(), modelRequestCount: 99 } });
    expect(store.metrics()).toBeNull();

    api.emit({ conversationId: 'conversation-1', metrics: metrics() });
    expect(store.modelRequestCount()).toBe(44);

    store.destroy();
    store.destroy();
    expect(api.unsubscribe).toHaveBeenCalledOnce();
    api.emit({ conversationId: 'conversation-1', metrics: { ...metrics(), modelRequestCount: 99 } });
    expect(store.modelRequestCount()).toBe(44);
  });

  it('does not apply an old conversation response after scope changes', async () => {
    let resolveList!: (value: { success: true; data: never[] }) => void;
    api.contextEvidenceList.mockImplementationOnce(() => new Promise((resolve) => {
      resolveList = resolve;
    }));
    const store = new ContextEvidenceStore();
    store.setScope(scope());
    const refresh = store.refresh();

    store.setScope({
      conversationId: 'conversation-2',
      owner: { kind: 'chat', chatId: 'chat-2' },
    });
    resolveList({ success: true, data: [] });
    await refresh;

    expect(api.contextEvidenceGetMetrics).not.toHaveBeenCalled();
    expect(store.metrics()).toBeNull();
  });

  it('clears previous conversation data and surfaces content-free IPC failures', async () => {
    const store = new ContextEvidenceStore();
    store.setScope(scope());
    await store.refresh();
    api.contextEvidenceList.mockResolvedValueOnce({
      success: false,
      error: { code: 'DENIED', message: 'Inspection unavailable', timestamp: 1 },
    });
    store.setScope({
      conversationId: 'conversation-2',
      owner: { kind: 'chat', chatId: 'chat-2' },
    });
    await store.refresh();

    expect(store.records()).toEqual([]);
    expect(store.metrics()).toBeNull();
    expect(store.error()).toBe('Inspection unavailable');
    expect(store.loading()).toBe(false);
  });
});

function makeApi() {
  let listener: ((update: ContextEvidenceStateChanged) => void) | null = null;
  const unsubscribe = vi.fn(() => { listener = null; });
  return {
    contextEvidenceList: vi.fn(async () => ({ success: true, data: [{ id: 'evidence-1' }] })),
    contextEvidenceGetCard: vi.fn(async () => ({
      success: true,
      data: { card: { id: 'card-1' }, tokenCount: 10, tokenLimit: 512, truncated: false },
    })),
    contextEvidenceSearch: vi.fn(async () => ({
      success: true,
      data: [{ evidenceId: 'evidence-1', preview: 'match' }],
    })),
    contextEvidenceRead: vi.fn(async () => ({
      success: true,
      data: { evidenceId: 'evidence-1', content: 'bounded excerpt' },
    })),
    contextEvidenceCompare: vi.fn(async () => ({ success: true, data: { equal: false } })),
    contextEvidenceVerify: vi.fn(async () => ({ success: true, data: { verified: true } })),
    contextEvidenceGetMetrics: vi.fn(async () => ({ success: true, data: metrics() })),
    onContextEvidenceStateChanged: vi.fn((callback: (update: ContextEvidenceStateChanged) => void) => {
      listener = callback;
      return unsubscribe;
    }),
    unsubscribe,
    emit: (update: ContextEvidenceStateChanged) => listener?.(update),
  };
}

function scope() {
  return {
    conversationId: 'conversation-1',
    owner: { kind: 'instance' as const, instanceId: 'instance-1' },
  };
}

function metrics(): ContextEvidenceRendererMetrics {
  return {
    occupancy: { status: 'known', used: 60_000, total: 100_000 },
    cumulativeTokens: 400_000,
    workingSet: {
      capacityTokens: 100_000,
      instructionsTokens: 15_000,
      recentDialogueTokens: 15_000,
      evidenceCardTokens: 15_000,
      exactExcerptTokens: 15_000,
      reasoningAndAnswerTokens: 25_000,
      emergencyReserveTokens: 15_000,
      normalWorkingSetTokens: 60_000,
      totalAllocatedTokens: 100_000,
      estimateKind: 'provider-tokenizer',
    },
    evidenceRecordCount: 8,
    evidenceCardCount: 6,
    exactExcerptCount: 2,
    externallyStoredBytes: 900_532,
    modelRequestCount: 44,
    toolCallCount: 31,
    toolResultBytes: 900_000,
    enforcementMode: 'shadow',
    lastAction: 'native-compaction',
    recoveryCount: 2,
    updatedAt: 500,
  };
}
