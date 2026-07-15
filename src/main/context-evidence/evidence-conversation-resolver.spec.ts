import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from '../../shared/types/chat.types';
import type { ConversationThreadRecord } from '../../shared/types/conversation-ledger.types';
import {
  EvidenceConversationResolver,
  getEvidenceProviderProvenance,
} from './evidence-conversation-resolver';
import {
  getContextEvidenceMode,
  normalizeContextEvidenceModeByProvider,
} from './context-evidence-settings';

function thread(
  id: string,
  metadata: Record<string, unknown> = {},
): ConversationThreadRecord {
  return {
    id,
    provider: 'orchestrator',
    nativeThreadId: `native-${id}`,
    nativeSessionId: null,
    nativeSourceKind: 'internal',
    sourceKind: 'orchestrator',
    sourcePath: null,
    workspacePath: '/work/project',
    title: null,
    createdAt: 1,
    updatedAt: 1,
    lastSyncedAt: 1,
    writable: true,
    nativeVisibilityMode: 'none',
    syncStatus: 'synced',
    conflictStatus: 'none',
    parentConversationId: null,
    metadata,
  };
}

function chat(ledgerThreadId: string): ChatRecord {
  return {
    id: 'chat-1',
    name: 'Chat',
    provider: 'claude',
    model: null,
    reasoningEffort: null,
    currentCwd: '/work/project',
    projectId: null,
    yolo: false,
    ledgerThreadId,
    currentInstanceId: 'instance-1',
    createdAt: 1,
    lastActiveAt: 1,
    archivedAt: null,
  };
}

function owner(overrides: Record<string, unknown> = {}) {
  return {
    id: 'instance-1',
    historyThreadId: 'history-1',
    provider: 'claude',
    providerSessionId: 'provider-session-1',
    sessionId: 'provider-session-1',
    workingDirectory: '/work/project',
    ...overrides,
  };
}

function harness(options: {
  chats?: Map<string, ChatRecord>;
  threads?: ConversationThreadRecord[];
} = {}) {
  const chats = options.chats ?? new Map<string, ChatRecord>();
  const threads = new Map((options.threads ?? []).map((row) => [row.id, row]));
  const ledger = {
    getThread: vi.fn(async (id: string) => threads.get(id) ?? null),
    listConversations: vi.fn(async () => [...threads.values()]),
    startConversation: vi.fn(async (input: { metadata?: Record<string, unknown> }) => {
      const created = thread(`created-${threads.size + 1}`, input.metadata);
      threads.set(created.id, created);
      return created;
    }),
  };
  const resolver = new EvidenceConversationResolver({
    ledger,
    chatStore: { getByInstanceId: (id: string) => chats.get(id) ?? null },
  });
  return { ledger, resolver };
}

describe('EvidenceConversationResolver', () => {
  it('uses the chat ledger thread for chat and borrowed-loop events, never mutable provider ids', async () => {
    const canonical = thread('chat-ledger');
    const collision = thread('other-aio-conversation');
    const chats = new Map([['instance-1', chat(canonical.id)]]);
    const { resolver } = harness({ chats, threads: [canonical, collision] });

    const first = await resolver.resolve(owner({
      providerSessionId: collision.id,
      sessionId: collision.id,
    }), { mode: 'shadow' });
    const borrowedLoop = await resolver.resolve(owner({
      providerSessionId: 'borrowed-provider-session-mutated-mid-loop',
      sessionId: 'borrowed-provider-session-mutated-mid-loop',
    }), { mode: 'shadow' });

    expect(first).toMatchObject({
      status: 'resolved',
      conversationId: canonical.id,
      source: 'chat-ledger',
    });
    expect(borrowedLoop).toMatchObject({
      status: 'resolved',
      conversationId: canonical.id,
      source: 'chat-ledger',
    });
  });

  it('uses an explicit AIO chat ownership anchor before provider or history ids', async () => {
    const canonical = thread('chat-ledger', { scope: 'chat', chatId: 'chat-1' });
    const collision = thread('provider-native-collision', {
      scope: 'instance',
      historyThreadId: 'different-history',
    });
    const { resolver } = harness({ threads: [canonical, collision] });

    const result = await resolver.resolve(owner({
      historyThreadId: collision.id,
      providerSessionId: collision.id,
      sessionId: collision.id,
      evidenceConversationOwner: {
        kind: 'chat',
        chatId: 'chat-1',
        conversationId: canonical.id,
      },
    }), { mode: 'shadow' });

    expect(result).toMatchObject({
      status: 'resolved',
      conversationId: canonical.id,
      source: 'chat-ledger',
    });
  });

  it('fails closed for a chat whose canonical ledger row is missing', async () => {
    const chats = new Map([['instance-1', chat('missing-chat-ledger')]]);
    const { ledger, resolver } = harness({ chats });

    const result = await resolver.resolve(owner({
      providerSessionId: 'malicious-existing-provider-native-id',
    }), { mode: 'enforce' });

    expect(result).toMatchObject({
      status: 'unresolved',
      reason: 'chat-ledger-thread-missing',
      disposition: 'pause-before-destructive-action',
      metric: {
        name: 'context_evidence_capture_failure',
        reason: 'unresolved-conversation-ownership',
        increment: 1,
      },
    });
    expect(ledger.listConversations).not.toHaveBeenCalled();
    expect(ledger.startConversation).not.toHaveBeenCalled();
  });

  it('reuses a restored standalone thread keyed by historyThreadId', async () => {
    const restored = thread('restored-ledger', {
      scope: 'instance',
      historyThreadId: 'history-restored',
    });
    const { ledger, resolver } = harness({ threads: [restored] });

    const result = await resolver.resolve(owner({
      id: 'restored-instance',
      historyThreadId: 'history-restored',
      providerSessionId: 'new-provider-session',
    }), { mode: 'shadow' });

    expect(result).toMatchObject({
      status: 'resolved',
      conversationId: restored.id,
      source: 'instance-history',
    });
    expect(ledger.startConversation).not.toHaveBeenCalled();
  });

  it('rejects a direct-id AIO collision whose instance metadata does not match', async () => {
    const collision = thread('provider-native-collision', {
      scope: 'instance',
      historyThreadId: 'somebody-elses-history',
    });
    const { ledger, resolver } = harness({ threads: [collision] });

    const result = await resolver.resolve(owner({
      historyThreadId: collision.id,
      providerSessionId: collision.id,
      sessionId: collision.id,
    }), { mode: 'enforce' });

    expect(result).toMatchObject({
      status: 'resolved',
      source: 'instance-history',
    });
    expect(result.status === 'resolved' ? result.conversationId : null).not.toBe(collision.id);
    expect(ledger.startConversation).toHaveBeenCalledOnce();
  });

  it('reuses a direct-id standalone row only when its instance metadata matches', async () => {
    const canonical = thread('history-direct', {
      scope: 'instance',
      historyThreadId: 'history-direct',
    });
    const { ledger, resolver } = harness({ threads: [canonical] });

    const result = await resolver.resolve(owner({ historyThreadId: canonical.id }), {
      mode: 'shadow',
    });

    expect(result).toMatchObject({
      status: 'resolved',
      conversationId: canonical.id,
      source: 'instance-history',
    });
    expect(ledger.startConversation).not.toHaveBeenCalled();
  });

  it('creates one AIO-owned thread for a new standalone instance and reuses it', async () => {
    const { ledger, resolver } = harness();
    const standalone = owner({ id: 'standalone-1', historyThreadId: 'history-new' });

    const created = await resolver.resolve(standalone, { mode: 'shadow' });
    const reused = await resolver.resolve(standalone, { mode: 'shadow' });

    expect(created).toMatchObject({ status: 'resolved', source: 'instance-history' });
    expect(reused).toMatchObject({
      status: 'resolved',
      conversationId: created.status === 'resolved' ? created.conversationId : undefined,
      source: 'instance-history',
    });
    expect(ledger.startConversation).toHaveBeenCalledTimes(1);
    expect(ledger.startConversation).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'orchestrator',
      workspacePath: '/work/project',
      metadata: expect.objectContaining({
        scope: 'instance',
        historyThreadId: 'history-new',
      }),
    }));
  });

  it('serializes concurrent creation for the same standalone history identity', async () => {
    const rows: ConversationThreadRecord[] = [];
    const ledger = {
      getThread: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
      listConversations: vi.fn(async () => [...rows]),
      startConversation: vi.fn(async (input: { metadata: Record<string, unknown> }) => {
        await Promise.resolve();
        const created = thread(`created-${rows.length + 1}`, input.metadata);
        rows.push(created);
        return created;
      }),
    };
    const firstResolver = new EvidenceConversationResolver({ ledger });
    const secondResolver = new EvidenceConversationResolver({ ledger });
    const standalone = owner({ id: 'standalone-race', historyThreadId: 'history-race' });

    const [first, second] = await Promise.all([
      firstResolver.resolve(standalone, { mode: 'shadow' }),
      secondResolver.resolve(standalone, { mode: 'enforce' }),
    ]);

    expect(ledger.startConversation).toHaveBeenCalledOnce();
    expect(rows).toHaveLength(1);
    expect(first.status === 'resolved' ? first.conversationId : null).toBe(rows[0]?.id);
    expect(second.status === 'resolved' ? second.conversationId : null).toBe(rows[0]?.id);
    expect(first.mode).toBe('shadow');
    expect(second.mode).toBe('enforce');
  });

  it('keeps provider-native identity in provenance without making it ownership', () => {
    expect(getEvidenceProviderProvenance(owner({
      provider: 'codex',
      providerSessionId: 'native-thread-9',
      sessionId: 'legacy-session-9',
    }))).toEqual({
      provider: 'codex',
      providerThreadRef: 'native-thread-9',
    });
  });
});

describe('context evidence provider modes', () => {
  const registry = {
    list: () => [
      { provider: 'claude' },
      { provider: 'codex' },
      { provider: 'cursor' },
    ],
    listPluginProviderAdapters: () => [
      { descriptor: { provider: 'plugin:local-test' } },
    ],
  };

  it('defaults every concrete registry adapter off, ignores auto, and maps openai to codex', () => {
    expect(normalizeContextEvidenceModeByProvider({
      auto: 'enforce',
      openai: 'shadow',
      unknown: 'enforce',
      claude: 'enforce',
    }, registry)).toEqual({
      claude: 'enforce',
      codex: 'shadow',
      cursor: 'off',
      'plugin:local-test': 'off',
    });
  });

  it('prefers an explicit canonical codex value over the legacy openai alias', () => {
    const normalized = normalizeContextEvidenceModeByProvider({
      codex: 'enforce',
      openai: 'shadow',
    }, registry);

    expect(normalized.codex).toBe('enforce');
    expect(getContextEvidenceMode(normalized, 'openai')).toBe('enforce');
    expect(getContextEvidenceMode(normalized, 'auto')).toBe('off');
  });
});
