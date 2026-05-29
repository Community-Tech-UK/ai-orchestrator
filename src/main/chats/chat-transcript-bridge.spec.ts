import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatRecord } from '../../shared/types/chat.types';
import type { ChatEvent } from '../../shared/types/chat.types';
import type { ConversationMessageRecord } from '../../shared/types/conversation-ledger.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

// The bridge transitively imports the conversation-ledger service (which imports
// electron); we inject a fake ledger, so stub the module to keep the import light.
vi.mock('../conversation-ledger', () => ({ getConversationLedgerService: vi.fn() }));
vi.mock('../providers/provider-output-event', () => ({
  toOutputMessageFromProviderEnvelope: vi.fn(() => null),
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ChatTranscriptBridge } from './chat-transcript-bridge';

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 'chat-1',
    name: 'Chat',
    provider: 'claude',
    model: null,
    reasoningEffort: null,
    currentCwd: null,
    projectId: null,
    yolo: false,
    ledgerThreadId: 'thread-1',
    currentInstanceId: null,
    createdAt: 1,
    lastActiveAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

function toolUseEnvelope(eventId: string): ProviderRuntimeEventEnvelope {
  return {
    instanceId: 'inst-1',
    eventId,
    turnId: 'turn-1',
    timestamp: 1000,
    event: { kind: 'tool_use', toolName: 'Read', toolUseId: `tu-${eventId}`, input: { file: 'x' } },
  } as unknown as ProviderRuntimeEventEnvelope;
}

/** Fake worker-backed ledger: assigns ids + sequences like the real worker. */
function makeLedger() {
  let seq = 0;
  return {
    appendMessagesReturningRecords: vi.fn(
      async (threadId: string, messages: Record<string, unknown>[]): Promise<ConversationMessageRecord[]> =>
        messages.map((m) => ({
          ...(m as object),
          id: `id-${++seq}`,
          threadId,
          sequence: seq,
        }) as ConversationMessageRecord),
    ),
  };
}

interface Harness {
  bridge: ChatTranscriptBridge;
  instanceManager: EventEmitter & { getInstance: ReturnType<typeof vi.fn> };
  eventBus: EventEmitter;
  ledger: ReturnType<typeof makeLedger>;
  chatStore: {
    get: ReturnType<typeof vi.fn>;
    getByInstanceId: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  events: ChatEvent[];
}

function setup(chat: ChatRecord = makeChat()): Harness {
  const instanceManager = Object.assign(new EventEmitter(), { getInstance: vi.fn(() => null) });
  const eventBus = new EventEmitter();
  const ledger = makeLedger();
  const chatStore = {
    get: vi.fn(() => chat),
    getByInstanceId: vi.fn(() => chat),
    update: vi.fn((id: string, patch: Partial<ChatRecord>) => ({ ...chat, ...patch })),
  };
  const events: ChatEvent[] = [];
  eventBus.on('chat:event', (e: ChatEvent) => events.push(e));

  const bridge = new ChatTranscriptBridge({
    ledger: ledger as never,
    chatStore: chatStore as never,
    instanceManager: instanceManager as never,
    eventBus,
    flushIntervalMs: 10_000, // long, so tests drive flush() explicitly
  });
  bridge.start();
  return { bridge, instanceManager, eventBus, ledger, chatStore, events };
}

describe('ChatTranscriptBridge (worker-backed deferred writes)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does ZERO synchronous SQLite on the event hot path', () => {
    const h = setup();
    h.instanceManager.emit('provider:normalized-event', toolUseEnvelope('e1'));

    // Nothing touches the stores or emits until the flush runs.
    expect(h.chatStore.get).not.toHaveBeenCalled();
    expect(h.chatStore.getByInstanceId).not.toHaveBeenCalled();
    expect(h.ledger.appendMessagesReturningRecords).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });

  it('coalesces a burst into a single batched ledger write + one chat update + one delta', async () => {
    const h = setup();
    h.instanceManager.emit('provider:normalized-event', toolUseEnvelope('e1'));
    h.instanceManager.emit('provider:normalized-event', toolUseEnvelope('e2'));
    h.instanceManager.emit('provider:normalized-event', toolUseEnvelope('e3'));

    await h.bridge.flush();

    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(1);
    const [threadId, messages] = h.ledger.appendMessagesReturningRecords.mock.calls[0];
    expect(threadId).toBe('thread-1');
    expect(messages).toHaveLength(3);
    expect(h.chatStore.update).toHaveBeenCalledTimes(1);
    expect(h.chatStore.update.mock.calls[0][1]).toHaveProperty('lastActiveAt');

    // One coalesced delta carrying all three authoritative records.
    expect(h.events).toHaveLength(1);
    const appended = h.events[0] as Extract<ChatEvent, { type: 'transcript-appended' }>;
    expect(appended.messages).toHaveLength(3);
    expect(appended.messages.map((m) => m.sequence)).toEqual([1, 2, 3]);
    expect(appended.messages[0].threadId).toBe('thread-1');
  });

  it('flushes pending writes when an instance is removed', async () => {
    const h = setup();
    h.instanceManager.emit('provider:normalized-event', toolUseEnvelope('e1'));
    expect(h.ledger.appendMessagesReturningRecords).not.toHaveBeenCalled();

    h.instanceManager.emit('instance:removed', 'inst-1');
    // instance:removed triggers an async flush; let it settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(1);
  });

  it('re-queues and retries (no data loss) when the ledger write fails', async () => {
    const h = setup();
    h.ledger.appendMessagesReturningRecords
      .mockRejectedValueOnce(new Error('worker restarting'))
      .mockImplementationOnce(async (threadId: string, messages: Record<string, unknown>[]) =>
        messages.map((m, i) => ({ ...(m as object), id: `r-${i}`, threadId, sequence: i + 1 }) as ConversationMessageRecord),
      );

    h.instanceManager.emit('provider:normalized-event', toolUseEnvelope('e1'));
    await h.bridge.flush(); // fails → re-queued, no emit
    expect(h.events).toHaveLength(0);

    await h.bridge.flush(); // retry succeeds
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(2);
    expect(h.events).toHaveLength(1);
  });

  it('does not throw if the chat cannot be resolved', async () => {
    const h = setup();
    h.chatStore.getByInstanceId.mockReturnValue(null);
    h.instanceManager.emit('provider:normalized-event', toolUseEnvelope('e1'));
    await expect(h.bridge.flush()).resolves.toBeUndefined();
    expect(h.ledger.appendMessagesReturningRecords).not.toHaveBeenCalled();
  });

  it('stop() cancels further bridging', async () => {
    const h = setup();
    h.bridge.stop();
    h.instanceManager.emit('provider:normalized-event', toolUseEnvelope('e1'));
    await h.bridge.flush();
    expect(h.ledger.appendMessagesReturningRecords).not.toHaveBeenCalled();
  });
});
