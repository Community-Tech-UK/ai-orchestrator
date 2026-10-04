import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { ConversationThreadRecord } from '../../shared/types/conversation-ledger.types';
import type { ChatRecord } from '../../shared/types/chat.types';

vi.mock('../conversation-ledger', () => ({ getConversationLedgerService: vi.fn() }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ChatTranscriptBridge, flushChatTranscriptSource } from './chat-transcript-bridge';

const bridges: ChatTranscriptBridge[] = [];
afterEach(() => {
  bridges.splice(0).forEach((bridge) => bridge.stop());
  vi.useRealTimers();
});

function setup() {
  const thread = {
    id: 'canonical-instance', provider: 'orchestrator', sourceKind: 'orchestrator',
    metadata: { scope: 'instance', historyThreadId: 'history-1' },
  } as unknown as ConversationThreadRecord;
  const instance = {
    id: 'instance-1', provider: 'codex', historyThreadId: 'history-1',
    providerSessionId: 'other-conversation',
    contextEvidence: { mode: 'enforce', conversationId: thread.id, captureFailureCount: 0 },
  };
  const manager = Object.assign(new EventEmitter(), { getInstance: vi.fn((): typeof instance | undefined => instance) });
  const ledger = {
    getThread: vi.fn(async (): Promise<ConversationThreadRecord | null> => thread),
    listConversations: vi.fn(async () => [thread]),
    startConversation: vi.fn(),
    appendMessagesReturningRecords: vi.fn(async (threadId: string, messages: object[]) =>
      messages.map((message, index) => ({ ...message, id: `message-${index}`, threadId, sequence: index + 1 }))),
  };
  const chatStore = {
    get: vi.fn((): ChatRecord | null => null),
    getByInstanceId: vi.fn((): ChatRecord | null => null), update: vi.fn(),
  };
  const bridge = new ChatTranscriptBridge({
    ledger: ledger as never, chatStore: chatStore as never, instanceManager: manager as never,
    eventBus: new EventEmitter(), flushIntervalMs: 10_000,
  });
  bridges.push(bridge);
  bridge.start();
  return { bridge, manager, ledger, instance, chatStore };
}

function tool(id = 'call-1'): ProviderRuntimeEventEnvelope {
  return {
    instanceId: 'instance-1', eventId: id, provider: 'codex', seq: 1, timestamp: 1,
    event: { kind: 'tool_use', toolName: 'list_remote_nodes', toolUseId: id, input: {} },
  };
}

function user(source: string): ProviderRuntimeEventEnvelope {
  return {
    ...tool('user-1'), raw: { source, payload: {} },
    event: { kind: 'output', messageType: 'user', messageId: 'user-1', content: 'Synthetic request' },
  };
}

describe('standalone canonical transcript source persistence', () => {
  it('persists a standalone tool call in its canonical evidence conversation', async () => {
    const h = setup();
    h.manager.emit('provider:normalized-event', tool());
    await h.bridge.flush();
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledWith(
      'canonical-instance', expect.arrayContaining([expect.objectContaining({ phase: 'tool_call' })]),
    );
  });

  it('persists real runtime user sends and excludes provider echoes', async () => {
    const h = setup();
    h.manager.emit('provider:normalized-event', user('adapter-event:output'));
    h.manager.emit('provider:normalized-event', user('instance-output'));
    await h.bridge.flush();
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledWith(
      'canonical-instance', [expect.objectContaining({ nativeMessageId: 'user-1', role: 'user' })],
    );
  });

  it('normalizes output tool messages into source-resolvable tool phases', async () => {
    const h = setup();
    h.manager.emit('provider:normalized-event', {
      ...tool(), event: {
        kind: 'output', messageType: 'tool_use', messageId: 'output-call', content: 'synthetic tool',
        metadata: { toolName: 'list_remote_nodes' },
      },
    });
    await flushChatTranscriptSource('instance-1');
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledWith('canonical-instance', [
      expect.objectContaining({ phase: 'tool_call', rawJson: { metadata: expect.objectContaining({ toolName: 'list_remote_nodes' }) } }),
    ]);
  });

  it('keeps chat user turns single when ChatService has already persisted them', async () => {
    const h = setup();
    const chat = { id: 'chat-1', ledgerThreadId: 'canonical-instance' } as ChatRecord;
    h.chatStore.get.mockReturnValue(chat);
    h.chatStore.getByInstanceId.mockReturnValue(chat);
    h.manager.emit('provider:normalized-event', user('instance-output'));
    await h.bridge.flushForSource('instance-1');
    expect(h.ledger.appendMessagesReturningRecords).not.toHaveBeenCalled();
  });

  it('leaves standalone evidence-off sessions inert', async () => {
    const h = setup();
    h.instance.contextEvidence.mode = 'off';
    h.manager.emit('provider:normalized-event', tool());
    await h.bridge.flush();
    expect(h.ledger.getThread).not.toHaveBeenCalled();
    expect(h.ledger.appendMessagesReturningRecords).not.toHaveBeenCalled();
  });

  it('waits for an in-flight write and drains a source queued while it was pending', async () => {
    const h = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    h.ledger.appendMessagesReturningRecords.mockImplementationOnce(async (threadId, messages) => {
      await pending;
      return messages.map((message, index) => ({ ...message, id: `message-${index}`, threadId, sequence: index + 1 }));
    });
    h.manager.emit('provider:normalized-event', tool('first-call'));
    const background = h.bridge.flush();
    await vi.waitFor(() => expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(1));
    h.manager.emit('provider:normalized-event', tool('second-call'));
    let settled = false;
    const barrier = h.bridge.flushForSource('instance-1').then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await background;
    await barrier;
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(2);
    expect(h.ledger.appendMessagesReturningRecords.mock.calls[1][1]).toEqual([
      expect.objectContaining({ nativeMessageId: 'chat-tool-use:second-call' }),
    ]);
  });

  it('rejects persistence failures without leaking the thrown message and permits a durable retry', async () => {
    const h = setup();
    h.ledger.appendMessagesReturningRecords.mockRejectedValueOnce(new Error('synthetic private failure detail'));
    h.manager.emit('provider:normalized-event', tool());
    await expect(h.bridge.flushForSource('instance-1')).rejects.toThrow('TRANSCRIPT_SOURCE_PERSISTENCE_FAILED');
    await expect(h.bridge.flushForSource('instance-1')).resolves.toBeUndefined();
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(2);
  });

  it('drains the already queued standalone tail after removed is emitted and the instance is deleted', async () => {
    const h = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    h.ledger.appendMessagesReturningRecords.mockImplementationOnce(async (threadId, messages) => {
      await pending;
      return messages.map((message, index) => ({ ...message, id: `message-${index}`, threadId, sequence: index + 1 }));
    });
    h.manager.emit('provider:normalized-event', tool('first-call'));
    const background = h.bridge.flush();
    await vi.waitFor(() => expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(1));
    h.manager.emit('provider:normalized-event', tool('queued-tail'));
    // The real termination coordinator emits synchronously, then deletes the
    // instance before the async transcript worker finishes its existing write.
    h.manager.emit('instance:removed', h.instance.id);
    h.manager.getInstance.mockReturnValue(undefined);
    release();
    await background;
    await h.bridge.drainForShutdown();
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(2);
    expect(h.ledger.appendMessagesReturningRecords.mock.calls[1]).toEqual([
      'canonical-instance', [expect.objectContaining({ nativeMessageId: 'chat-tool-use:queued-tail' })],
    ]);
    await expect(h.bridge.flushForSource('instance-1')).resolves.toBeUndefined();
    // A later event cannot reuse the retiring ownership snapshot.
    h.manager.emit('provider:normalized-event', tool('late-event'));
    await h.bridge.flush();
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(2);
    h.manager.getInstance.mockReturnValue(h.instance);
    h.manager.emit('provider:normalized-event', tool('after-cleanup'));
    await h.bridge.flush();
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(3);
  });

  it('never uses a retiring snapshot instead of a live changed owner', async () => {
    const h = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    h.ledger.appendMessagesReturningRecords.mockImplementationOnce(async (threadId, messages) => {
      await pending;
      return messages.map((message, index) => ({ ...message, id: `message-${index}`, threadId, sequence: index + 1 }));
    });
    h.manager.emit('provider:normalized-event', tool('first-call'));
    const background = h.bridge.flush();
    await vi.waitFor(() => expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(1));
    h.manager.emit('provider:normalized-event', tool('queued-tail'));
    h.manager.emit('instance:removed', h.instance.id);
    h.instance.contextEvidence.conversationId = 'changed-owner';
    release();
    await background;
    await expect(h.bridge.flushForSource('instance-1')).rejects.toThrow('TRANSCRIPT_SOURCE_OWNERSHIP_CHANGED');
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(1);
  });

  it('retains removed ownership while a transient write failure and its queued tail are retried', async () => {
    const h = setup();
    let fail!: () => void;
    h.ledger.appendMessagesReturningRecords.mockImplementationOnce(() => new Promise((_, reject) => {
      fail = () => reject(new Error('synthetic private failure detail'));
    }));
    h.manager.emit('provider:normalized-event', tool('first-call'));
    const background = h.bridge.flush();
    await vi.waitFor(() => expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(1));
    h.manager.emit('provider:normalized-event', tool('queued-tail'));
    h.manager.emit('instance:removed', h.instance.id);
    h.manager.getInstance.mockReturnValue(undefined);
    fail();
    await background;
    await h.bridge.drainForShutdown();
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(2);
    expect(h.ledger.appendMessagesReturningRecords.mock.calls[1]).toEqual([
      'canonical-instance', [
        expect.objectContaining({ nativeMessageId: 'chat-tool-use:first-call' }),
        expect.objectContaining({ nativeMessageId: 'chat-tool-use:queued-tail' }),
      ],
    ]);
    await expect(h.bridge.flushForSource('instance-1')).resolves.toBeUndefined();
    h.manager.emit('provider:normalized-event', tool('late-event'));
    await h.bridge.flush();
    expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(2);
  });

  it('rejects missing ownership even after its batch was dropped', async () => {
    const h = setup();
    h.instance.historyThreadId = '';
    h.manager.emit('provider:normalized-event', tool());
    await h.bridge.flush();
    await expect(h.bridge.flushForSource('instance-1')).rejects.toThrow('TRANSCRIPT_SOURCE_OWNERSHIP_UNRESOLVED');
    expect(h.ledger.appendMessagesReturningRecords).not.toHaveBeenCalled();
  });

  it('does not move a queued source record into a newly selected conversation', async () => {
    const h = setup();
    h.manager.emit('provider:normalized-event', tool());
    h.instance.contextEvidence.conversationId = 'changed-owner';
    await expect(h.bridge.flushForSource('instance-1')).rejects.toThrow('TRANSCRIPT_SOURCE_OWNERSHIP_CHANGED');
    expect(h.ledger.appendMessagesReturningRecords).not.toHaveBeenCalled();
  });

  it('rejects ownership changes while a durable write is pending', async () => {
    const h = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    h.ledger.appendMessagesReturningRecords.mockImplementationOnce(async (threadId, messages) => {
      await pending;
      return messages.map((message, index) => ({ ...message, id: `message-${index}`, threadId, sequence: index + 1 }));
    });
    h.manager.emit('provider:normalized-event', tool());
    const assertion = expect(h.bridge.flushForSource('instance-1')).rejects.toThrow('TRANSCRIPT_SOURCE_OWNERSHIP_CHANGED');
    await vi.waitFor(() => expect(h.ledger.appendMessagesReturningRecords).toHaveBeenCalledTimes(1));
    h.instance.contextEvidence.conversationId = 'changed-owner';
    release();
    await assertion;
  });

  it('never turns must-not-persist provider events into durable source messages', async () => {
    const h = setup();
    h.manager.emit('provider:normalized-event', { ...tool(), ephemeral: true });
    await h.bridge.flushForSource('instance-1');
    expect(h.ledger.appendMessagesReturningRecords).not.toHaveBeenCalled();
  });

  it('bounds a wedged worker wait and rejects a stopped or unavailable bridge', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.ledger.appendMessagesReturningRecords.mockImplementationOnce(() => new Promise(() => undefined));
    h.manager.emit('provider:normalized-event', tool());
    const assertion = expect(h.bridge.flushForSource('instance-1')).rejects.toThrow('TRANSCRIPT_SOURCE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
    h.bridge.stop();
    await expect(h.bridge.flushForSource('instance-1')).rejects.toThrow('TRANSCRIPT_SOURCE_STOPPED');
    await expect(flushChatTranscriptSource('instance-1')).rejects.toThrow('TRANSCRIPT_SOURCE_UNAVAILABLE');
  });
});
